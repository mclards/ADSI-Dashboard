// One-shot: regenerate docs/ADSI-Dashboard-User-Guide.pdf from the HTML guide.
// Mirrors the AGENTS.md headless-print contract using the bundled puppeteer.
"use strict";
const path = require("path");
const puppeteer = require("puppeteer");

(async () => {
  const html = path.resolve(__dirname, "..", "docs", "ADSI-Dashboard-User-Guide.html");
  const pdf = path.resolve(__dirname, "..", "docs", "ADSI-Dashboard-User-Guide.pdf");
  const url = "file://" + html.split(path.sep).join("/");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdf,
      printBackground: true,
      format: "A4",
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
    console.log("PDF regenerated -> " + pdf);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
