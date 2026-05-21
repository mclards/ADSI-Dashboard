# Code Signing — ADSI Inverter Dashboard

This dashboard uses a **self-signed code signing certificate** for installer EXEs.
Because it's a custom-built application for a single station (not a public product),
a self-signed cert is the right trade-off: zero cost, full tamper detection, and
no SmartScreen warnings on the gateway machine after a one-time root cert install.

---

## Files

All code signing artifacts live in `build/private/` (gitignored):

| File | Purpose | Status |
|------|---------|--------|
| `codesign.pfx` | Private key + cert. Used by `electron-builder` to sign installers. | **PRIVATE — back up to password manager** |
| `codesign.cer` | Public cert only. Install on the gateway machine. | Safe to distribute |
| `codesign.env` | Build env vars (`CSC_LINK`, `CSC_KEY_PASSWORD`). | **PRIVATE — back up with PFX** |
| `codesign-thumbprint.txt` | SHA-1 thumbprint reference | Reference only |

**Certificate details:**
- Subject: `CN=Engr. Clariden D. Montaño REE, O=MCTech Engineering, C=PH`
- Issuer: same (self-signed)
- Algorithm: RSA-4096 / SHA-256
- Validity: 10 years from generation
- Thumbprint: see `codesign-thumbprint.txt`
- Code Signing EKU: `1.3.6.1.5.5.7.3.3`

---

## First-time setup

### 1. Generate the certificate (one time only)

```bash
npm run codesign:generate
```

This creates the 4 files above. Run only once — regenerating the cert will
**break auto-update** for any already-installed dashboard, because the
publisher hash will change.

### 2. Back up the PFX and password

Immediately after generation, copy these files to a safe location:

- `build/private/codesign.pfx`
- `build/private/codesign.env`

**Recommended:** save them to a password manager entry titled
"ADSI Dashboard Code Signing Cert" along with the regeneration date.

If you lose the PFX, you cannot sign new releases as the same publisher and
auto-update will break for existing installs. There is no recovery.

### 3. Install the public cert on the gateway machine

Copy `build/private/codesign.cer` to the gateway server, then install it
into the **Trusted Root Certification Authorities** store:

**GUI method (easiest):**
1. Right-click `codesign.cer` → **Install Certificate**
2. Store Location: **Local Machine** (requires admin)
3. Click Next, then select **Place all certificates in the following store**
4. Browse → select **Trusted Root Certification Authorities** → OK
5. Click Next → Finish
6. Confirm the security warning prompt (Windows asks because it's a self-signed root)

**PowerShell method:**
```powershell
Import-Certificate -FilePath "codesign.cer" -CertStoreLocation "Cert:\LocalMachine\Root"
```
(Run as Administrator.)

After this is done, the gateway machine will:
- Show "MCTech Engineering" as the verified publisher in installer dialogs
- Allow installs and auto-updates with no SmartScreen warnings
- Verify the signature on every dashboard EXE

This is a **one-time setup per machine**. The cert is valid for 10 years.

---

## Building a signed installer

```bash
npm run build:installer:signed
```

This wraps `electron-builder` and:
1. Loads `CSC_LINK` and `CSC_KEY_PASSWORD` from `build/private/codesign.env`
2. Resolves `CSC_LINK` to an absolute path
3. Runs `electron-builder --win nsis --x64`
4. electron-builder calls `signtool` with the PFX, applies SHA-256 signing,
   and counter-signs with the Sectigo public timestamp authority

All three build commands — `build:win`, `build:installer`, and
`build:installer:signed` — route through the same wrapper script and enforce
the same safety gates:

1. **Gate 1 — signing required.** If `build/private/codesign.env` is missing
   or the PFX path is invalid, the build fails fast with a clear error.
   Shipping an unsigned installer would break auto-update for existing signed
   installs (electron-updater rejects publisher-hash mismatches).
2. **Gate 2 — post-build signature verification.** After electron-builder
   finishes, the wrapper calls `scripts/verify-signed-installer.ps1` which
   runs `Get-AuthenticodeSignature` and pins the thumbprint to
   `build/private/codesign-thumbprint.txt`.
3. **Gate 3 — size floor + SHA-512 log.** Rejects implausibly small builds
   (missing Python services, broken extraResources) and logs the SHA-512
   that electron-updater will expect in `latest.yml`.

For dev builds where a signature isn't needed, opt out explicitly:

```bash
ADSI_ALLOW_UNSIGNED=1 npm run build:installer
```

This skips Gate 2 (nothing to verify) but still enforces Gate 3.

---

## Verifying a signed installer

```bash
# Find signtool first
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"

# Verify (use /pa for default authentication policy)
& $signtool verify /pa /v "release/Inverter-Dashboard-Setup-2.7.18.exe"
```

**Expected on a machine WITHOUT the root cert installed:**
```
SignTool Error: A certificate chain processed, but terminated in a root
        certificate which is not trusted by the trust provider.
```
This is normal — it just means the verifying machine doesn't trust the
self-signed root yet.

**Expected on a machine WITH the root cert installed:**
```
Successfully verified: release/Inverter-Dashboard-Setup-2.7.18.exe
```

---

## Renewing or rotating the cert

The cert is valid for 10 years. When you need to rotate (or if compromised):

1. **Delete** `build/private/codesign.pfx` (and the env file)
2. Run `npm run codesign:generate` again — generates a fresh keypair
3. The new cert will have a different thumbprint
4. **Re-install the new `codesign.cer`** on the gateway machine
5. The next signed release will use the new identity

⚠️ During rotation, electron-updater will refuse the first update from the
new cert because the publisher hash differs from the previously-installed
version. You'll need to manually install the first build with the new
cert (uninstall the old dashboard first, or accept the publisher-mismatch
prompt). Plan rotations during a maintenance window.

---

## Why self-signed and not a real CA?

- **Single-station deployment:** the dashboard ships to one known gateway,
  not a public download. Self-signed works perfectly for this case.
- **Cost:** real EV certs cost $250-700/year. Azure Trusted Signing is
  $120/year but not available in the Philippines yet.
- **March 2024 SmartScreen change:** Microsoft removed the "instant trust"
  benefit of EV certs. Even paid certs now require reputation building.
  For a low-volume custom application, you'd never reach the reputation
  threshold anyway.
- **One-time setup:** installing the root cert on the gateway is a 30-second
  task during initial deployment. After that, all auto-updates run silently.

When the project scales to multiple sites, revisit this — Azure Trusted
Signing or a Certum OV cert (~$65/yr) would be the next step.

---

## Security notes

- The PFX private key never leaves `build/private/` and is gitignored
- The password is randomly generated (32 chars, mixed case + digits + symbols)
- Both the PFX and env file are double-protected by `.gitignore` rules
- NTFS ACLs on the PFX and env file are restricted to the current user only
  (the generation script applies this automatically; no inheritance, no Administrators access)
- `git check-ignore` is used after generation to verify nothing leaks
- No password is ever hardcoded in `package.json` or scripts

### Defense in depth: vault the PFX

The PFX and `codesign.env` should NOT live on the build machine permanently.
For best security:

1. **Generate the cert** with `npm run codesign:generate`
2. **Immediately copy** `build/private/codesign.pfx` and `codesign.env` to a
   password manager or encrypted USB drive
3. **Delete** the local copies between builds:
   ```powershell
   Remove-Item build/private/codesign.pfx, build/private/codesign.env -Force
   ```
4. **Restore** them from the vault when you need to build:
   ```powershell
   # Copy from password manager / USB to build/private/ before:
   npm run build:installer:signed
   ```
5. **Delete again** after the release is published

This eliminates plaintext password exposure on the build machine between
release cycles. The PFX is only on disk during the actual build window.

For convenience, you can keep the PFX on disk if the build machine is
itself well-protected (full-disk encryption, locked, dedicated build user
account). The ACL hardening applied by the generation script restricts
access to the current user even without vaulting.

### If the build machine is compromised

Treat the PFX as compromised:
1. Delete `build/private/codesign.pfx` and `codesign.env`
2. Regenerate the cert: `npm run codesign:generate`
3. Re-install the new `codesign.cer` on every gateway machine
4. Plan a maintenance window — auto-update will reject the next release
   because the publisher hash changed (electron-updater expects continuity)

### Verifying trust on a gateway

After installing `codesign.cer` on a gateway machine, verify it worked:

```bash
npm run codesign:verify
```

This script checks both `LocalMachine\Root` and `CurrentUser\Root` stores
for the cert by thumbprint, and if a built installer is present, runs
`signtool verify /pa` to confirm the trust chain end-to-end.
