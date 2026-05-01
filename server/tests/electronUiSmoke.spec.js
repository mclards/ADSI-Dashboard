"use strict";

const fs = require("fs");
const path = require("path");
const { test, expect, _electron: electron } = require("playwright/test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ELECTRON_EXE =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");
const ARTIFACT_DIR = path.join(REPO_ROOT, "server", "tests", "artifacts");
const LAUNCH_ENV = { ...process.env };
delete LAUNCH_ENV.ELECTRON_RUN_AS_NODE;

async function waitForWindow(electronApp, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastUrls = [];
  while (Date.now() < deadline) {
    const windows = electronApp.windows();
    lastUrls = [];
    for (const page of windows) {
      try {
        const url = String(page.url() || "");
        lastUrls.push(url);
        if (await predicate(page, url)) return page;
      } catch (_) {
        // Window may still be initializing; retry until timeout.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for target window. Last URLs: ${lastUrls.join(", ")}`);
}

test.describe("Electron UI smoke", () => {
  test.setTimeout(120000);

  test("dashboard, export, and connectivity surfaces render in Electron", async () => {
    expect(fs.existsSync(ELECTRON_EXE)).toBeTruthy();
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

    const electronApp = await electron.launch({
      executablePath: ELECTRON_EXE,
      args: [REPO_ROOT],
      cwd: REPO_ROOT,
      env: {
        ...LAUNCH_ENV,
        ELECTRON_ENABLE_LOGGING: "1",
      },
    });

    try {
      const loginWindow = await electronApp.firstWindow();
      await loginWindow.waitForLoadState("domcontentloaded");

      // Reuse the existing preload IPC instead of assuming workstation credentials.
      await loginWindow.evaluate(() => window.loginAPI.loginSuccess());

      const mainWindow = await waitForWindow(
        electronApp,
        async (page, url) => {
          if (!url.startsWith("http://localhost:3500")) return false;
          await page.waitForLoadState("domcontentloaded");
          return true;
        },
        60000,
      );

      await expect(mainWindow.locator("#totalPac")).toBeVisible();
      await expect(mainWindow.locator("#totalKwh")).toBeVisible();
      await expect(mainWindow.locator("#totalPac")).not.toHaveText(/^\s*[—-]?\s*$/);
      await expect(mainWindow.locator("#totalKwh")).not.toHaveText(/^\s*[—-]?\s*$/);

      await mainWindow.selectOption("#invFilter", "1");
      await expect(mainWindow.locator("#invDetailPanel")).toBeVisible();
      await expect
        .poll(
          async () => String((await mainWindow.locator("#invDetailStats").textContent()) || "").trim(),
          { timeout: 30000 },
        )
        .not.toContain("Loading");
      await expect(mainWindow.locator("#invDetailStats")).toContainText("Today Energy", {
        timeout: 30000,
      });
      await expect(mainWindow.locator("#invDetailStats")).toContainText("DC Power", {
        timeout: 30000,
      });

      await mainWindow.locator('[data-page="export"]').evaluate((el) => el.click());
      await expect(mainWindow.locator("#page-export")).toBeVisible();
      await expect(mainWindow.locator("#expEnergyDate")).toBeVisible();
      await expect(
        mainWindow.locator('#page-export input[type="date"][id^="expEnergy"]'),
      ).toHaveCount(1);
      await expect(mainWindow.locator("#expEnergyStart")).toHaveCount(0);
      await expect(mainWindow.locator("#expEnergyEnd")).toHaveCount(0);

      await mainWindow.locator('[data-page="settings"]').evaluate((el) => el.click());
      await mainWindow
        .locator('[data-settings-section="connectivitySection"]')
        .evaluate((el) => el.click());
      await expect(mainWindow.locator("#repConnectedVal")).toBeVisible();
      await mainWindow.locator("#btnRefreshReplicationHealth").click();
      await expect
        .poll(
          async () => String((await mainWindow.locator("#repConnectedVal").textContent()) || "").trim(),
          { timeout: 20000 },
        )
        .not.toBe("—");

      await mainWindow.screenshot({
        path: path.join(ARTIFACT_DIR, "electron-ui-smoke.png"),
        fullPage: true,
      });
    } finally {
      await electronApp.close().catch(() => {});
    }
  });
});
