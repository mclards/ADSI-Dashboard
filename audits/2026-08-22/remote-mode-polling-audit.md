# Remote Mode Polling Audit

This document details the architectural audit of the ADSI-Dashboard's remote mode polling mechanisms. It explains why the Dashboard app (Electron) exhibits "not polling" behavior while the Web mode (PWA) operates correctly when both connect to a remote gateway.

## 1. Architectural Differences: Web Mode vs. Dashboard App
While both interfaces share `public/js/app.js`, they interact with the remote gateway fundamentally differently:

- **Web Mode (Browser PWA):** 
  When a user opens the browser to the remote gateway (e.g., `http://100.115.222.36:3500`), the browser connects **directly** to the gateway. The web UI operates in "Gateway Mode" (as it reflects the gateway's native state) and its WebSocket is authenticated via the recently patched session cookie (`remoteApiTokenGate`).
- **Dashboard App (Electron Viewer):**
  When the Dashboard app is set to "Remote Mode", it does **not** connect the UI directly to the remote gateway. Instead, the local Node.js server (`server/index.js`) acts as a bridge. It connects to the remote gateway via a backend WebSocket (`connectRemoteBridgeSocket()`), receives the data, and re-broadcasts it to the local Electron UI over `ws://localhost:3500/ws`.

## 2. Why the Dashboard App Appears to "Not Poll"
The perception or reality of the Dashboard app not polling stems from three major factors:

### A. Intentional UI Disablement (Poll Cadence Chip)
In `public/js/app.js`, several frontend polling mechanisms are intentionally disabled when the client detects it is in remote mode:
```javascript
// Disables the Poll Cadence Chip
async function refreshPollCadenceChip() {
  if (getActiveOperationModeClient() === "remote") return;
  // ...
}

// Disables HTTP fallback polling for Today MWh
function startTodayMwhSyncTimer() {
  if (getActiveOperationModeClient() === "remote") return;
  // ...
}
```
If a user compares the Gateway's native web interface (which shows the active poll cadence) with the Dashboard App in Remote Mode (which hides/disables it), the Dashboard App will appear as if it is "not polling", even if it is successfully receiving live WebSocket frames.

### B. The Node.js WebSocket Bridge Lacks Keep-Alives
The backend remote bridge (`connectRemoteBridgeSocket` in `server/index.js`) uses Node's `ws` library to connect to the remote gateway.
```javascript
  const ws = new WebSocket(wsUrl, {
    headers: buildRemoteProxyHeaders(),
    handshakeTimeout: REMOTE_FETCH_TIMEOUT_MS,
  });
```
Unlike a browser WebSocket which has native TCP keep-alive handling, this Node.js implementation does not implement a `ping/pong` heartbeat. Over unstable networks (like CGNAT/Tailscale), stateful firewalls will silently drop the connection. The server does not detect the dropped connection because `ws.on('close')` is never fired, leaving the Dashboard App permanently frozen.

### C. Dead Code: `pollRemoteLiveOnce()`
There is a fully implemented HTTP polling fallback function in `server/index.js` named `pollRemoteLiveOnce()`:
```javascript
async function pollRemoteLiveOnce() {
  // ... HTTP fetch implementation
}
```
This function is completely **orphaned (dead code)**. It is never called anywhere in the application. The system relies 100% on the `connectRemoteBridgeSocket` WebSocket stream. If the WebSocket bridge hangs, there is no HTTP fallback to recover the polling state.

## 3. Remote Token Authentication Constraints
The Dashboard App bridge relies on injecting the token via headers:
```javascript
function buildRemoteProxyHeaders(tokenOverride = "") {
  // ...
  headers["x-inverter-remote-token"] = token;
}
```
The Gateway's `browserAuth.authorizeWebSocket` validates this token. However, if the token is misconfigured or mismatched on the Dashboard App, the gateway silently rejects the WebSocket upgrade with a `1008` close code, triggering a reconnection loop in `index.js` that users interpret as a frozen dashboard.

## Recommendations for Resolution
To fix the Dashboard app's polling discrepancy, the following patches should be applied:
1. **Implement WS Keep-Alives:** Add a ping/pong interval (e.g., 15s) to `connectRemoteBridgeSocket()` so the local server can detect silent drops and trigger `scheduleRemoteBridgeReconnect()`.
2. **Revive or Remove `pollRemoteLiveOnce`:** Either implement a timeout that falls back to `pollRemoteLiveOnce()` HTTP polling when the WebSocket is unhealthy, or remove the dead code to reduce architectural confusion.
3. **UI Transparency:** Modify `refreshPollCadenceChip()` in `app.js` to show a "Remote Stream Active" indicator instead of completely disabling the chip, providing users visual confirmation that data is flowing.
