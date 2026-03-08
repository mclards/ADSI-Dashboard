# Refined Implementation Plan: Inter-Machine Operator Messaging Panel

## Status

Implemented in `v2.2.16`.

Implemented files:

- `server/db.js`
- `server/index.js`
- `public/index.html`
- `public/css/style.css`
- `public/js/app.js`

## Goal

Implement a lightweight operator-to-operator messaging panel for the two supported dashboard roles:

- `gateway`: plant-connected workstation and canonical data source
- `remote`: supervised workstation that connects through the gateway

The feature must behave like an operational notification surface, not a consumer chat page. It should stay compact, theme-consistent, and reliable even when the gateway link is temporarily unavailable.

## Scope

Included in v1:

- One conversation shared between the gateway machine and the remote machine
- Short plain-text messages only
- Floating bubble + slide-in panel UI
- Local unread badge
- Soft notification sound for incoming messages
- Gateway-hosted canonical message storage
- Remote polling bridge through the existing gateway token flow

Explicitly out of scope for v1:

- Attachments, images, files, emojis, reactions
- Typing indicators, presence, online status, delivery status
- Message edit/delete
- Multiple rooms or multiple operators
- Persistent offline outbound queue
- Search, filtering, export, or a full-page chat history

## Key Design Decisions

1. The browser always talks to its own local Express server.
2. The gateway stores the canonical message thread.
3. The remote server acts as a bridge, not as a second source of truth.
4. Message transport uses monotonic `id` cursors, not timestamps, to avoid duplicate or missed rows.
5. Read receipts are updated only when the operator opens or reads the thread, never during background polling.
6. Outbound messages are plain text only and must be sanitized before storage or rendering.

## User Experience

1. A floating message bubble is always available near the bottom-right of the dashboard.
2. If the existing alarm bell is also visible, the two floating controls must not overlap. Stack or offset them intentionally.
3. Incoming messages from the opposite machine open the panel automatically, play a short notification sound, and update the unread badge if the panel was closed.
4. Messages sent by the current machine appear immediately after the gateway accepts them. Self-sent messages do not play a sound.
5. The panel shows only the latest 20 messages in ascending order.
6. The panel auto-dismisses 30 seconds after the last message or user activity.
7. Auto-dismiss must pause while the input has focus and contains an unsent draft.
8. Clicking the bubble toggles the panel open or closed.
9. Opening the panel clears the local unread badge and marks visible inbound messages as read.
10. If sending fails, the draft stays in the input and the user gets a concise error toast.

## Operator Copy Direction

UI text should feel operational and professional:

- Panel title: `Operator Messages`
- Input placeholder: `Write a short operator note...`
- Empty state: `No recent operator messages.`
- Dismiss hint: `Closes automatically after inactivity`

Do not expose internal transport details, tokens, or server terminology in the visible UI.

## Architecture

### High-Level Flow

```text
Remote browser
  -> local remote server (/api/chat/send, /api/chat/messages, /api/chat/read)
  -> gateway server (machine-to-machine, token-authenticated)
  -> gateway DB + gateway local WS broadcast

Gateway browser
  -> local gateway server
  -> gateway DB + gateway local WS broadcast

Remote inbound transport
  <- remote server poll loop
  <- gateway server /api/chat/messages?afterId=...&mode=inbox&machine=remote
  -> remote local WS broadcast
```

### Behavioral Rules

- All canonical message rows live on the gateway.
- The remote server polls the gateway every 5 seconds for inbound rows addressed to `remote`.
- The gateway does not need to know the remote machine address.
- Both browsers receive updates through their own local WebSocket via `broadcastUpdate({ type: "chat", row })`.
- Background polling is transport only. It must not mark rows as read.

## Message Identity

Use settings already present in the dashboard:

| Field | Source | Notes |
|------|--------|------|
| `from_machine` | local `operationMode` | `gateway` or `remote` |
| `to_machine` | derived opposite of sender | explicit in DB for clarity and query safety |
| `from_name` | local `plantName` + `operatorName` | e.g. `ADSI Plant - OPERATOR` |

Frontend should not invent these fields. The local server should derive them from current settings.

## Data Model

### Gateway Table: `chat_messages`

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  from_machine TEXT NOT NULL CHECK (from_machine IN ('gateway', 'remote')),
  to_machine   TEXT NOT NULL CHECK (to_machine IN ('gateway', 'remote')),
  from_name    TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  read_ts      INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_to_machine_id
  ON chat_messages(to_machine, id);
```

### Retention

- Retain the latest 500 rows by default.
- Purge oldest rows by `id` after successful insert.
- Optional setting name if later exposed: `chatRetainCount`.

### Validation Rules

- Plain text only
- Trim leading and trailing whitespace
- Normalize CRLF to LF before storage
- Reject empty result after trimming
- Maximum stored length: 500 characters
- Never store raw HTML

## API Contract

The browser always uses local routes. In `remote` mode, the local route proxies to the gateway when needed.

### `POST /api/chat/send`

Browser request body:

```json
{ "message": "Transformer inspection completed." }
```

Server behavior:

1. Derive `from_machine`, `to_machine`, and `from_name` from local settings.
2. Validate and sanitize the message.
3. If local mode is `gateway`:
   - insert row in `chat_messages`
   - broadcast locally via WS
   - return canonical row
4. If local mode is `remote`:
   - forward to gateway using `remoteGatewayUrl` and `remoteApiToken`
   - gateway inserts row and returns canonical row
   - local remote server broadcasts that canonical row to its own browser
   - return canonical row to the renderer

Response:

```json
{ "ok": true, "row": { "id": 42, "ts": 1740000000000, "from_machine": "remote", "to_machine": "gateway", "from_name": "ADSI Plant - OPERATOR", "message": "..." } }
```

Important:

- The remote browser must not create a fake local row before the gateway acknowledges it.
- If the gateway is unreachable, return an error and keep the draft intact.

### `GET /api/chat/messages`

Used for history load and remote inbound polling.

Query options:

| Query | Use |
|------|-----|
| `limit=20` | latest thread view for the renderer |
| `afterId=<id>` | incremental fetch |
| `mode=thread` | return full thread rows for UI history |
| `mode=inbox` | return only rows addressed to the requesting machine |
| `machine=gateway|remote` | requesting machine identity when proxied/polled |

Behavior:

- `mode=thread`: return latest thread rows ordered ascending for renderer display
- `mode=inbox`: return only rows where `to_machine = machine` and `id > afterId`
- Do not update `read_ts`

Renderer history calls:

```text
GET /api/chat/messages?mode=thread&limit=20
```

Remote poll calls:

```text
GET /api/chat/messages?mode=inbox&machine=remote&afterId=<lastInboundId>&limit=50
```

### `POST /api/chat/read`

Browser request body:

```json
{ "upToId": 42 }
```

Behavior:

- Mark rows as read only where:
  - `to_machine` matches the local machine
  - `id <= upToId`
  - `read_ts IS NULL`
- In `remote` mode, proxy this action to the gateway

Response:

```json
{ "ok": true, "updated": 3 }
```

## Backend Responsibilities

### `server/db.js`

Add:

- table creation for `chat_messages`
- prepared statements or helper functions for:
  - insert row
  - fetch latest thread rows
  - fetch inbound rows after `id`
  - mark rows read up to `id`
  - purge oldest rows beyond retention

### `server/index.js`

Add:

- local renderer routes:
  - `POST /api/chat/send`
  - `GET /api/chat/messages`
  - `POST /api/chat/read`
- remote-mode poll loop startup and shutdown handling
- proxy logic for `remote` mode
- local WS broadcasts using existing `broadcastUpdate()`

### Remote Poll Loop

Rules:

- Run only when local `operationMode === "remote"`
- Use existing `remoteGatewayUrl` and `remoteApiToken`
- Poll every 5000 ms
- Track `lastInboundChatId`
- Request only `mode=inbox&machine=remote`
- On new rows:
  - update `lastInboundChatId`
  - broadcast each row locally
- On network failure:
  - log a concise warning without message content
  - keep the app running
  - do not clear local thread state

If operation mode changes at runtime:

- stop the poll loop when leaving `remote`
- start the poll loop when entering `remote`
- reset the inbound cursor after a successful history refresh

## Frontend Responsibilities

### State Additions in `public/js/app.js`

```js
chatOpen: false,
chatUnread: 0,
chatMessages: [],
chatDismissTimer: null,
chatLastReadId: 0,
chatLastInboundId: 0,
chatPendingSend: false,
chatAudioReady: false,
```

Notes:

- Deduplicate rows by `id`
- Keep only the latest 20 rows in state
- `chatUnread` counts only rows from the opposite machine that have not been cleared locally

### WebSocket Handling

Extend the existing WS message switch:

```js
case "chat":
  handleIncomingChatMessage(d.row);
  break;
```

### Required Frontend Functions

#### `mergeChatRows(rows)`

- sanitize array input
- dedupe by `id`
- sort ascending by `id`
- cap to latest 20 rows

#### `handleIncomingChatMessage(row)`

- merge the row into `State.chatMessages`
- if the row is inbound from the opposite machine:
  - increment unread if panel is closed
  - auto-open panel
  - play sound
- if panel is open:
  - render immediately
  - mark read if this row is inbound
- reset dismiss timer

#### `openChatPanel()`

- add `.chat-panel--open`
- render current thread
- clear local unread badge
- mark visible inbound rows read
- start dismiss timer

#### `closeChatPanel()`

- remove `.chat-panel--open`
- clear dismiss timer
- keep thread state intact

#### `resetChatDismissTimer()`

- clear existing timeout
- if input is focused and has non-empty draft, do not auto-close yet
- otherwise close after 30000 ms

#### `loadChatHistory()`

- call local `GET /api/chat/messages?mode=thread&limit=20`
- merge returned rows into state
- update `chatLastInboundId` using the newest inbound row

#### `markChatRead()`

- find latest visible inbound row for this machine
- call local `POST /api/chat/read`
- update `State.chatLastReadId`

#### `sendChatMessage()`

- trim input
- validate length
- disable send button while request is in flight
- `POST /api/chat/send` to local server
- on success:
  - merge returned canonical row
  - clear input
  - render thread
  - reset dismiss timer
- on failure:
  - keep draft text
  - show concise toast

#### `playChatSound()`

- only for inbound rows from the opposite machine
- no sound for self-send echoes
- use Web Audio API
- reuse the same user-gesture audio unlock strategy already used elsewhere in the app if possible

## HTML Plan

Add the messaging panel near the end of `public/index.html`, before `</body>`.

Suggested structure:

```html
<!-- Operator Messaging -->
<button id="chatBubble" class="chat-bubble" type="button" aria-label="Open operator messages">
  <span class="mdi mdi-message-text" aria-hidden="true"></span>
  <span id="chatBadge" class="chat-badge" hidden>0</span>
</button>

<section id="chatPanel" class="chat-panel" aria-label="Operator messages">
  <div class="chat-panel-header">
    <div>
      <div class="chat-panel-title">Operator Messages</div>
      <div class="chat-panel-subtitle">Gateway and remote operator notes</div>
    </div>
    <button id="chatClose" class="chat-close-btn" type="button" aria-label="Close operator messages">
      <span class="mdi mdi-close" aria-hidden="true"></span>
    </button>
  </div>

  <div id="chatThread" class="chat-thread">
    <div class="chat-empty">No recent operator messages.</div>
  </div>

  <div class="chat-input-row">
    <input
      id="chatInput"
      class="chat-input inp"
      type="text"
      maxlength="500"
      autocomplete="off"
      placeholder="Write a short operator note..."
    />
    <button id="chatSend" class="chat-send-btn btn-primary" type="button">Send</button>
  </div>

  <div class="chat-autodismiss-bar">
    <span class="chat-dismiss-hint">Closes automatically after inactivity</span>
  </div>
</section>
```

## CSS Plan

Use existing theme tokens only:

- `--surface`
- `--surface2`
- `--border`
- `--border2`
- `--text`
- `--text2`
- `--accent`
- `--red`

Requirements:

- compact and readable in `dark`, `light`, and `classic`
- no overlap with footer
- no overlap with `#notifBell`
- mobile-safe below 480 px
- slide-in from right with intentional motion
- scrollable message thread with `min-height: 0`

Message styling:

- self messages right-aligned
- inbound messages left-aligned
- sender name + time in small muted text
- message body in rounded bubble

## Sound Plan

Use a short in-memory Web Audio tone:

- 2 tones
- under 250 ms total
- low volume
- no bundled audio file

Sound must fire only when:

- the row is inbound from the opposite machine
- the browser has already unlocked audio through a user gesture

## Edge Cases

1. Remote sends while gateway is offline:
   - do not create a phantom message
   - keep the draft
   - show toast: `Gateway unavailable. Message not sent.`

2. Remote poll retries after timeout:
   - use `afterId`
   - dedupe in frontend by `id`

3. Browser reload:
   - `loadChatHistory()` repopulates the latest 20 rows

4. Same timestamp rows:
   - safe because transport uses `id`, not `ts`

5. Operator opens panel after receiving several messages:
   - clear local unread
   - mark inbound rows read up to visible newest inbound `id`

6. Empty or whitespace-only input:
   - block send
   - no network call

7. Mode switch at runtime:
   - stop or start remote poll loop cleanly

## Files to Change

| File | Change |
|------|--------|
| `server/db.js` | table creation, prepared statements, retention helper, read/update helpers |
| `server/index.js` | local routes, remote proxy logic, remote poll loop, WS broadcast integration |
| `public/index.html` | floating bubble + slide-in messaging panel markup |
| `public/css/style.css` | bubble, panel, thread, badges, transitions, responsive behavior |
| `public/js/app.js` | state, WS handling, render/update/send/read logic, sound, auto-dismiss |

Optional but recommended if logic grows:

| File | Purpose |
|------|---------|
| `server/chatStore.js` | isolate DB read/write helpers from `server/index.js` |
| `server/tests/chatCore.test.js` | validation and cursor/read helper coverage |

## Verification Checklist

1. Gateway sends a message and sees it appear immediately in its own panel.
2. Remote receives that message within the next poll cycle and gets panel open + sound.
3. Remote replies and sees the canonical row locally after gateway acknowledgement.
4. Gateway receives the reply through local WS broadcast immediately.
5. Self-sent messages do not trigger the notification sound.
6. Background polling alone does not mark messages as read.
7. Opening the panel marks visible inbound rows as read.
8. Auto-dismiss closes after 30 seconds of inactivity.
9. Auto-dismiss does not close while the operator is actively typing an unsent draft.
10. Gateway outage does not crash the remote server.
11. Bubble and alarm bell do not overlap.
12. Panel looks correct in `dark`, `light`, and `classic`.
13. Panel remains usable on narrow width layouts.
14. `node --check server/index.js`
15. `node --check public/js/app.js`

## Implementation Recommendation

Build in this order:

1. Gateway DB schema and local gateway routes
2. Remote proxy send/history/read behavior
3. Remote inbound poll loop
4. Frontend state + rendering
5. Floating UI and theming polish
6. Read-receipt and edge-case verification
