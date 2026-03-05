"use strict";
/**
 * tokenStore.js — AES-256-GCM encrypted cloud OAuth token storage.
 * Tokens are encrypted at rest using a machine-derived key so they cannot
 * be trivially extracted from the data directory.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

const ALGORITHM = "aes-256-gcm";
const CONTEXT = "inverter-dashboard-cloud-tokens-v1";

function deriveKey() {
  // Stable machine-specific fingerprint (not user-entered).
  const fingerprint = [os.hostname(), os.platform(), os.arch(), CONTEXT].join("|");
  return crypto.createHash("sha256").update(fingerprint).digest();
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload, key) {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload");
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

class TokenStore {
  constructor(dataDir) {
    this._storeFile = require("path").join(dataDir, "cloud_tokens.enc");
    this._key = deriveKey();
    this._cache = {};
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._storeFile)) return;
      const raw = fs.readFileSync(this._storeFile, "utf8").trim();
      if (!raw) return;
      this._cache = JSON.parse(decrypt(raw, this._key));
    } catch (err) {
      console.warn("[tokenStore] Failed to load tokens:", err.message);
      this._cache = {};
    }
  }

  _save() {
    try {
      const json = JSON.stringify(this._cache);
      const encrypted = encrypt(json, this._key);
      fs.writeFileSync(this._storeFile, encrypted, { mode: 0o600 });
    } catch (err) {
      console.error("[tokenStore] Failed to save tokens:", err.message);
    }
  }

  /** Store token data for a provider. Never log these values. */
  set(provider, tokenData) {
    if (!provider || typeof tokenData !== "object" || tokenData === null) return;
    this._cache[provider] = { ...tokenData, _storedAt: Date.now() };
    this._save();
  }

  /** Get token data for a provider, or null if not stored. */
  get(provider) {
    return this._cache[provider] || null;
  }

  /** Remove stored token for a provider (disconnect). */
  delete(provider) {
    delete this._cache[provider];
    this._save();
  }

  /**
   * Returns true if access token is expired or missing.
   * Considers a 90-second buffer to avoid edge-case expiry during upload.
   */
  isExpired(provider) {
    const t = this._cache[provider];
    if (!t || !t.access_token) return true;
    if (!t.expires_at) return false; // no expiry info, assume valid
    return Date.now() >= Number(t.expires_at) - 90_000;
  }

  /** Returns true if a token is stored (connected), regardless of expiry. */
  isConnected(provider) {
    return !!this._cache[provider]?.access_token;
  }

  /** Summary of connected providers (no token values exposed). */
  listConnected() {
    return Object.keys(this._cache).map((p) => ({
      provider: p,
      connectedAt: this._cache[p]._storedAt || null,
      expired: this.isExpired(p),
    }));
  }
}

module.exports = TokenStore;
