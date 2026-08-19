# Browser Availability & PWA Implementation Plan

This plan aims to make the ADSI Inverter Dashboard available as a Progressive Web App (PWA) across Android and iOS devices, fixing the data-loading issue and providing a native-app feel when added to the home screen.

## Proposed Changes

### Backend Server Changes

#### [MODIFY] [`server/index.js`](file:///d:/ADSI-Dashboard/server/index.js)
- Update the CORS policy `LOCAL_ORIGIN_RE` to allow connections from local area networks (192.168.*.*, 10.*.*.*) and Tailscale VPN IPs (100.*.*.*) in addition to localhost. This will allow the remote browsers to successfully stream live data and fetch API results without being blocked by security policies.

### Frontend Progressive Web App (PWA) Setup

#### [NEW] [`public/manifest.json`](file:///d:/ADSI-Dashboard/public/manifest.json)
- Create a standard PWA manifest defining the app name, start URL (`/`), and display mode (`standalone`) to ensure it opens in full-screen mode on iOS and Android without the browser search bar.
- Register the existing `icon-256.png` as the application icon.

#### [MODIFY] [`public/index.html`](file:///d:/ADSI-Dashboard/public/index.html)
- Add `<link rel="manifest" href="/manifest.json" />` to the document `<head>`.
- Add Apple-specific PWA meta tags to support iOS devices (`apple-mobile-web-app-capable` and `apple-touch-icon`).

#### [MODIFY] [`public/login.html`](file:///d:/ADSI-Dashboard/public/login.html)
- Apply the same PWA headers to ensure the app stays in standalone mode during authentication and doesn't kick the user out to the regular browser.

## Verification Plan

### Manual Verification
- Once executed, you will need to restart the backend Node.js server.
- Open the dashboard via Tailscale IP (`http://100.81.240.80:3500/`) in Safari (iOS) or Chrome (Android).
- Verify that live data loads correctly instead of showing an empty UI.
- Select "Add to Home Screen" to install the app.
- Open it from your phone's home screen to verify it opens in full-screen standalone mode with the correct icon.
