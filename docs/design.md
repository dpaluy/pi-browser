# Pi Browser design

Pi Browser gives each Pi session a `browser` tool that works in the user's own Chrome or Brave profile, only in
tabs of the session's own tab group, without bringing those tabs to the front.

```
Pi session A ──┐ unix socket (NDJSON)                     native messaging (stdio)
Pi session B ──┼──────────────────────── host/relay.js ─────────────────────────── extension (MV3 service worker)
Pi session C ──┘  <agentDir>/browser/sockets/<id>.sock     started by the browser      chrome.debugger → tabs
```

## Identity

| Thing | Value |
| --- | --- |
| npm package | `@dpaluy/pi-browser` |
| Extension ID | `odhaeafpfooplfbcefglfcmlpbedofdo` (fixed by `key` in `extension/manifest.json`) |
| Native host name | `dev.majesticlabs.pi_browser` |
| Pi data folder | `<agentDir>/browser/` with `settings.json` and `sockets/` (`agentDir` from `getAgentDir()`) |
| Tab group title | `pi · <session name>`; `pi · <session name> (ended)` after the session exits |

## Files

```
extension/manifest.json   permissions: debugger, nativeMessaging, tabs, tabGroups, storage, alarms (no host permissions)
extension/background.js   entry: wires transport, sessions, and actions
extension/transport.js    native port, handshake, reconnect with backoff, request dispatch
extension/groups.js       session ↔ tab group registry, current tab per session, persisted in chrome.storage.session
extension/cdp.js          attach/detach, send with timeout, event fan-out, per-tab state, focus emulation
extension/snapshot.js     accessibility tree → text lines with refs
extension/input.js        mouse, keyboard, drag, wheel through Input.*
extension/actions.js      one handler per method below
host/relay.js             native messaging host (plain Node ESM, no dependencies)
src/index.ts              Pi extension entry: registers the tool and /browser
src/tool.ts               TypeBox schema, tool description, param normalization
src/server.ts             per-session unix socket server and request/response client
src/approvals.ts          host approvals: once, session, always, deny; retry loop on needs-approval
src/settings.ts           <agentDir>/browser/settings.json, atomic writes
src/install.ts            native host manifest + launcher for every detected browser
src/view.ts               read output: offset paging, interactive filter, truncation note
src/targets.ts            Jev element resolution and find output (uses src/jev.ts)
src/jev.ts                TypeSafe Jev client (exists)
src/render.ts             TUI renderCall / renderResult
test/*.test.ts            unit tests (node:test)
test/e2e/*                Chrome for Testing end-to-end suite
```

## Wire protocol

Protocol version: `PROTOCOL = 1`. Every layer refuses a peer with another version, with an error that names both
versions and says to reload the extension in `chrome://extensions` and run `/reload` in Pi.

### Pi session ↔ relay: unix socket, newline-delimited JSON

The Pi session listens on `<agentDir>/browser/sockets/<sessionId>.sock` (socket `0600`, folder `0700`) from its
first browser use until `session_shutdown`, then removes the socket file. One relay connection is served at a
time; a second connection while one is live gets `{"refused":"another browser profile is connected"}` and is
closed.

Messages the relay delivers to Pi come from the extension. Messages Pi writes go to the extension.

```
ext → pi   {"hello":{"protocol":1,"extension":"0.1.0","browser":"Chrome/141.0…"}}
pi  → ext  {"hello":{"protocol":1,"session":"<id>","name":"<session name>"}}
pi  → ext  {"id":7,"method":"click","params":{...},"allowed":["example.com"],"name":"<session name>"}
ext → pi   {"id":7,"result":{...}}
ext → pi   {"id":7,"error":{"message":"..."}}
ext → pi   {"id":7,"error":{"message":"...","code":"needs-approval","host":"cdn.example.net","acted":false}}
```

- `allowed` lists the hosts this session may act on for this one call: always-allowed, session-allowed, and
  allowed-once grants made earlier in the same tool call.
- `name` is sent with every request so a renamed session's group is retitled on its next action.
- Pi times out a request after 60 s (`wait` after its own timeout + 5 s) with a clear error.

### Relay ↔ extension: native messaging

Chrome frames stdio messages as a 4-byte little-endian length plus UTF-8 JSON. Messages:

```
ext   → relay  {"hello":{"protocol":1}}                       first message
relay → ext    {"hello":{"protocol":1,"relay":"0.1.0"}}
relay → ext    {"session":"<id>","open":true}                 a session socket is connected
relay → ext    {"session":"<id>","open":false}                that socket closed (session ended or crashed)
relay → ext    {"session":"<id>","message":{...}}             from Pi
ext   → relay  {"session":"<id>","message":{...}}             to Pi
```

The relay watches the sockets folder (`fs.watch` plus a rescan every 2 s), connects to each `*.sock`, and labels
every message by the socket it arrived on. The extension trusts only that label, never ids inside messages. The
relay exits when stdin closes. It writes diagnostics only to stderr.

## Extension behavior

- **Connection.** The service worker connects with `chrome.runtime.connectNative` on startup, on install, on the
  toolbar icon click, and on a 1-minute `chrome.alarms` tick while disconnected (backoff 1 s → 30 s inside a
  live worker). The action title shows `Pi Browser: connected`, `…: N sessions`, or the last error.
- **Groups.** Each session owns at most one tab group, created on its first `navigate`. A tab belongs to a session
  only while it is in that session's group; a tab the user drags in joins it. Requests for any other tab fail with
  `Tab <id> is not in your group.` The session's current tab is the last tab it navigated or acted on; when that
  tab closes, the most recently used remaining tab in the group becomes current. When a session closes, its group
  is retitled `(ended)`, its tabs stay, and the debugger detaches from them. A session that reconnects with the
  same id takes its group back.
- **Approval.** Before acting, the extension takes the host of the tab's main frame and fails with
  `needs-approval` (`acted:false`) if it is not in `allowed`. `navigate` checks the target URL first. After any
  navigation (`navigate`, history, or a click that navigates during the action) it checks where the page ended; a
  new unapproved host fails with `needs-approval` and `acted:true`, returning nothing from the page. Input into a
  cross-site frame (point actions, a ref inside such a frame, typing where focus is in one) needs that frame's
  host. Only `http:` and `https:` pages are acted on.
- **Debugger.** Attach on first use per tab (`chrome.debugger.attach`, version `1.3`) and enable
  `Page`, `Network`, `DOM`, `Accessibility`, then `Emulation.setFocusEmulationEnabled {enabled:true}` so the tab
  takes input and renders screenshots while hidden, behind another tab, or in a minimized window. `Runtime` and
  `Log` are enabled only once the agent uses `console`, since some sites detect it. Detach when the tab leaves the
  group or its session ends. When the user cancels the debugger infobar, refuse actions until the toolbar icon is
  clicked.
- **Dialogs.** A JavaScript dialog opening during an action fails the action at once:
  `The page opened a <type> dialog ("<message>"); answer it in the browser, then try again.` The dialog stays.
  A dialog from a page on an unapproved host fails with `needs-approval` (`acted:true`) and no message text.
- **Never steals focus.** No action activates a tab or focuses a window. New tabs open with `active:false` in the
  window of the session's group, or the last focused normal window for the first tab.

### Methods

All methods take an optional `tabId`; without it they use the session's current tab. Every result has
`text` (shown to the model) and may have `image: {data, mimeType:"image/jpeg", width, height}`.

| Method | Params | Behavior |
| --- | --- | --- |
| `status` | | `{text}` with extension version, browser, session count. No approval. |
| `tabs` | | `{tabs:[{id, title, url, current}], others:n}`. No approval; Pi hides title and path of unapproved hosts. |
| `navigate` | `url`, `newTab` | Load and wait for `load` up to 15 s, then return the header line; on timeout return it with `(still loading)`. |
| `back`, `forward`, `reload` | | Same wait. `back`/`forward` with no history entry fail `Tab <id> has no page to go <back|forward> to.` |
| `close` | | Close the tab: `Closed tab <id>.` |
| `read` | | Snapshot text (below). Pi applies offset/interactive. |
| `click` | `ref` or `point`, `button`, `clickCount` | Scroll ref into view, hit-test its center (`DOM.getNodeForLocation`); if another element covers it fail naming it, except a label that targets it. Mouse move, press, release. Result names the element. |
| `hover` | `point` | Mouse move; result names the element under it. |
| `drag` | `point`, `to` | Press at point, move in 5 steps, release at `to`. HTML5 drag and drop through `Input.setInterceptDrags` + `Input.dispatchDragEvent`. |
| `type` | `ref`?, `text` | Focus the ref (or use the focused element; fail if none), `Input.insertText`. |
| `keys` | `ref`?, `keys` | Space-separated keys/combos (`Enter`, `Shift+Tab`, `Meta+a`). On macOS Meta+a/c/v/x/z map to editing `commands`. |
| `scroll` | `ref`, or `point` + `delta` | `DOM.scrollIntoViewIfNeeded`, or a wheel at the point. |
| `fill` | `fields:[{ref,value}]` | In order; stop at the first failure, saying what was done. Text replaced (`""` clears); select by label or value; checkbox/radio/switch `"true"`/`"false"`; date/time/color by value format, verified. Fires `input` and `change`. |
| `select` | `ref`, `values` | Native `<select>`: match label (case-insensitive) or value; several only for `multiple`; missing option lists all options; disabled option fails. |
| `upload` | `ref`, `paths` | File input: `DOM.setFileInputFiles`. Other element: `Page.setInterceptFileChooserDialog`, click, take `Page.fileChooserOpened`. |
| `wait` | `text`?, `gone`?, `timeout` | Poll `document.body.innerText` (case-insensitive) every 200 ms; no text: `readyState complete` and no requests in flight for 500 ms. Default 10 s. |
| `screenshot` | | JPEG (quality 80) of the viewport at CSS pixel size, scaled to ≤1568 px long edge and ≤1.15 MP. Remember `{scale, viewport, scroll}` for points. |
| `zoom` | `region` | Re-capture that region of the last screenshot at up to 4× CSS resolution within the same caps. |
| `console` | | Messages and exceptions since the page loaded (last 200, each ≤1000 chars). |
| `network` | | `METHOD status type URL` lines (last 200); never headers or bodies. Shows a request only when its host and the origin of the frame that made it are approved; the rest become `<n> requests to sites you haven't approved are hidden.` `data:` URLs show as `data:<mime> (<n> bytes)`. |
| `eval` | `code` | `Runtime.evaluate` with `replMode`, `awaitPromise`, `returnByValue`, 10 s timeout; result JSON. |

Points `[x, y]` and zoom regions `[x, y, width, height]` are in pixels of the tab's last screenshot; the
extension divides by that screenshot's scale. Scroll deltas `[dx, dy]` are in CSS pixels. `wait.timeout` is in
milliseconds. `gone` can be `true` with `text`, or the text to wait to disappear. A point action on a tab without a screenshot fails: `Take a screenshot first; points are in its pixels.`

### Snapshot format

```
Tab 123: Page title <https://example.com/path>
heading "Welcome"
  Some paragraph text
[41] link "Sign in"
[52] textbox "Email" = "a@b.co"
[53] checkbox "Remember me" (checked)
[60] combobox "Country" = "Canada" (collapsed)
```

- One line per node, indented two spaces per depth; ignored nodes and `generic`/`none` wrappers are skipped
  without adding depth; text equal to its parent's name is not repeated.
- `[n]` is the node's `backendDOMNodeId`, given to interactive roles: button, link, textbox, searchbox, combobox,
  listbox, option, checkbox, radio, switch, slider, spinbutton, tab, menuitem(+checkbox/radio), treeitem, and the
  date, time, and color input roles.
- States in parentheses: checked/unchecked/mixed, pressed, expanded/collapsed, selected, disabled, required.
- Same-origin child frames are inlined under their `Iframe` line; cross-site frames show only
  `Iframe "<title>" (cross-site <host>, not read)`.
- Refs are valid until the main frame navigates; an unknown or stale ref fails
  `Ref [n] is not on the page anymore; read again.`

## Pi side

- **Tool.** One tool, `browser`, registered only when `ctx.hasUI && ctx.mode === "tui"` (Pi also reports
  `hasUI` in RPC mode); print/RPC modes and subagents never see it. Params an action does not take are dropped
  before sending, so models that fill every field work. Zero, empty string, and empty array mean "not given"
  for optional parameters; a fill field’s empty `value` still clears the field.
- **Approvals.** On `needs-approval` Pi asks `Let the agent use <host> in the browser?` with
  `Allow once`, `Allow for this session`, `Always allow`, `Deny`, then retries a request that has not acted
  with the grant (once grants last for this tool call only). If `acted:true`, it must not replay the request
  (for example a click could submit again, or `back` could move twice). After a grant it returns
  `The browser action already ran and reached <host>; it was not repeated. Read the page before continuing.`
  Deny fails: `The user did not allow the browser on <host>.` One call asks at most once per host.
  Always-allowed hosts live in `settings.json` (`alwaysAllow`).
- **Eval confirmation.** With `confirmEval` on, Pi shows the code and runs it only on `Run all <n> lines`. Code is
  capped at 20 lines and 1,500 characters, no two blank lines in a row, no invisible/control characters except
  newline and tab.
- **Upload confirmation.** Pi resolves paths against `cwd` (and `~`), checks each is a file, and asks
  `Let the agent attach <these files> to a page on <host>?` listing every absolute path. If the upload would
  reach a new host before acting (for example a cross-site file input or a tab that navigated during the prompt),
  confirm the same paths for that host before sending it as allowed for the upload.
- **Tabs output.** `Tab <id>: <title> <url> (current)`; unapproved hosts as `Tab <id>: <host>`; last line
  `<n> other tabs are not in your group.`
- **Read output.** `view(text, offset, interactive)` in `src/view.ts`; truncation to
  `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES` names the next offset. Offsets count raw snapshot lines from zero,
  even with interactive filtering; the next offset is immediately after the last displayed line.
- **Jev.** With `TYPESAFE_API_KEY`, the schema adds `find` and `target` (on click, type, select, keys, scroll,
  upload, and each fill field). Without it, neither appears.
- **Images.** Screenshots and zooms are returned as image content and saved under a private `mkdtemp` folder
  `pi-browser-*`; the text gives the path and size.
- **`/browser`.** Installs/refreshes the native host for every detected browser, then shows the extension folder,
  the extension ID, and connection status. `/browser settings` toggles eval confirmation. `/browser sites` lists
  always-allowed hosts and removes one the user picks.
- **Install.** For each existing browser data folder (macOS `~/Library/Application Support/<…>`, Linux
  `~/.config/<…>`: Google Chrome, Chrome Beta/Dev/Canary, Chromium, Brave, Microsoft Edge, Vivaldi), write
  `NativeMessagingHosts/dev.majesticlabs.pi_browser.json` (`allowed_origins` = our extension only) and a launcher
  `dev.majesticlabs.pi_browser.sh` that `exec`s the Node running Pi with `host/relay.js <socketsDir>`. Refuse when
  Pi does not run on Node (`process.versions.bun`, single executable).

### Module API (shared by the extension entry, unit tests, and the e2e suite)

```ts
// src/index.ts
export interface BrowserOptions {
  agentDir?: string;          // default getAgentDir(); settings.json and sockets/ live in <agentDir>/browser
  browserDirs?: string[];     // default detectBrowserDirs(); where the host is installed on first use
  typesafeKey?: string;       // default process.env.TYPESAFE_API_KEY
  connectTimeoutMs?: number;  // how long a call waits for the extension to connect; default 15000
  requestTimeoutMs?: number;  // default 60000
}
export function browserExtension(options?: BrowserOptions): (pi: ExtensionAPI) => void;
export default browserExtension();

// src/install.ts
export const HOST_NAME = "dev.majesticlabs.pi_browser";
export const EXTENSION_ID = "odhaeafpfooplfbcefglfcmlpbedofdo";
export function detectBrowserDirs(home?: string, platform?: NodeJS.Platform): string[];
export async function installHost(browserDirs: string[], socketsDir: string): Promise<string[]>; // manifest paths written

// src/view.ts
export function view(text: string, offset?: number, interactive?: boolean): string;
```

On its first browser use a session installs the host into `browserDirs` and opens its socket, so the e2e suite
points `browserDirs` at the test profile and `agentDir` at a temporary folder.

## Not in scope for 0.1

Windows, an on-page cursor overlay, password-manager frames that block the debugger, reading cross-site frames.
