# Pi Browser

[![npm version](https://img.shields.io/npm/v/@dpaluy/pi-browser.svg)](https://www.npmjs.com/package/@dpaluy/pi-browser)

Let Pi work in your signed-in Chrome or Brave. Each Pi session uses its own tab group without bringing it to the front.

## Install

Requires Pi running on Node.js 22.19 or later on macOS or Linux, and a browser based on Chromium 125 or later. Pi running on Bun or as a standalone executable is not supported.

```sh
pi install npm:@dpaluy/pi-browser
```

1. Restart Pi or run `/reload`, then run `/browser` in an interactive Pi session. It installs or refreshes the native messaging host for detected browsers and shows the extension folder and connection status.
2. In the browser profile you want Pi to use, open `chrome://extensions` or `brave://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extension folder shown by `/browser`. Click the Pi Browser toolbar icon if it doesn't connect, then run `/browser` again to check the status.

## Use

Ask Pi to open an HTTP or HTTPS page. `navigate` creates the first tab in the session's group. The tabs stay open when the session ends. Tab actions use the session's current tab unless you pass `tabId`.

| Action | Parameters besides `action` and `tabId` | What it does |
| --- | --- | --- |
| `status` | — | Show the extension version, browser, and connected session count. |
| `tabs` | — | List the session's tabs and count the other tabs. |
| `navigate` | `url`, optional `newTab` | Open a URL in the current tab or a new background tab. |
| `back` | — | Go back in the tab's history. |
| `forward` | — | Go forward in the tab's history. |
| `reload` | — | Reload the tab. |
| `close` | — | Close the tab. |
| `read` | Optional `offset`, `interactive` | Read the accessibility snapshot and get numeric element refs. Use a zero-based line offset to continue or `interactive: true` to show only the header and lines with refs. |
| `click` | `ref`, `target`, or `point`; optional `button`, `clickCount` | Click an element or a point. |
| `hover` | `point` | Move the pointer over a point. |
| `drag` | `point`, `to` | Drag from one point to another. |
| `type` | `text`, optional `ref` or `target` | Insert text into an element or the focused control. |
| `keys` | `keys`, optional `ref` or `target` | Send space-separated keys or chords, such as `Shift+Tab Enter`. |
| `scroll` | `ref` or `target`, or `point` and `delta` | Scroll an element into view or wheel at a point by `[dx, dy]` in CSS pixels. |
| `fill` | `fields`: entries with `ref` or `target` and a string `value` | Fill fields in order, stopping at the first failure. |
| `select` | `ref` or `target`, `values` | Choose options in a native select by label or value. |
| `upload` | `ref` or `target`, `paths` | Attach local files after you confirm the paths and destination host. |
| `wait` | Optional `text`, `gone`, `timeout` | Wait for text to appear, disappear (`gone: true` with `text`, or a string in `gone`), or for the page to become idle. Default timeout: 10,000 ms. |
| `screenshot` | — | Capture the viewport as a JPEG. |
| `zoom` | `region` | Recapture a region of the last image at higher detail. |
| `console` | — | Show buffered browser log messages and exceptions. |
| `network` | — | Show recent request methods, statuses, types, and URLs, without headers or bodies. Requests to or from sites you haven't approved are only counted. |
| `eval` | `code` | Run JavaScript in the page. Pi asks for confirmation by default; `/browser settings` toggles it. |
| `find` | `query` | Search the page snapshot by meaning. Requires `TYPESAFE_API_KEY`. |

Take a screenshot before using points (`[x, y]`) or a zoom region (`[x, y, width, height]`). These coordinates are in pixels of the last screenshot or zoom. If a `ref` goes stale, run `read` again. Set `TYPESAFE_API_KEY` before starting Pi to enable `find` and use a plain-language `target` in place of a `ref` where listed.

## Site approval

Pi asks for approval when the tool encounters a hostname you haven't approved. Choose **Allow once** (for that tool call), **Allow for this session**, **Always allow**, or **Deny**. Use `/browser sites` to remove a saved approval. The `tabs` action doesn't prompt; for unapproved sites it shows the hostname, not the title or full URL.

An action such as a click or navigation may already have reached a new host when Pi asks. Pi withholds the page result and doesn't repeat the action, even if you approve the new host. Read the page before continuing. Input directed into a cross-site frame can require separate approval for that frame's host.

## Privacy

What leaves your machine:

- Your model provider receives browser tool output, which can include page text, URLs, diagnostic output, local screenshot paths, and screenshots.
- With `TYPESAFE_API_KEY` set, `find` and `target` lookups send TypeSafe the lookup text and accessibility snapshot text, including the tab title and URL. They don't send screenshot images.
- The site can receive what the agent types, fills in, or uploads, just as if you did it in the browser.

What is stored locally:

- `~/.pi/agent/browser/settings.json` stores `alwaysAllow` (saved hostnames) and `confirmEval` (whether to ask before running page JavaScript). If `PI_CODING_AGENT_DIR` is set, the `browser` directory is under that path instead.
- Pi saves a local JPEG for each screenshot or zoom in a `pi-browser-*` folder under the system temp directory. Pi does not delete these copies.
- The relay and Pi communicate over local Unix sockets in `browser/sockets/` under the Pi agent directory. Pi closes the session socket on shutdown.

## Security

The extension declares no host permissions. It holds these permissions:

- `debugger` to read and interact with tabs in the session's group, capture screenshots, and collect diagnostics.
- `nativeMessaging` to connect to the local relay. The native host manifest allows only the Pi Browser extension ID.
- `tabs` to inspect tab metadata and manage tabs, and `tabGroups` to track and label session groups.
- `storage` to keep group state and the debugger pause flag in browser session storage.
- `alarms` to retry the native connection when disconnected.

## Limits

- Windows is not supported. The installer looks for standard browser data folders on macOS and Linux; it does not set up Snap or Flatpak browsers.
- On macOS, Brave looks for the per-user native host manifest in its real browser data folder (`~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`), not in a temporary profile passed via `--user-data-dir`.
- `read` includes same-origin frames but does not read cross-site frame contents. Screenshots can still show what's visible in the viewport.
- The tool does not operate native dialogs or file pickers. Answer JavaScript dialogs and complete CAPTCHAs yourself. `upload` sets a web page's file input without operating the native picker.
- The tool is available in interactive Pi sessions, not print or RPC mode.

## Troubleshooting

- **Not connected:** Open the browser once so its data folder exists, run `/browser`, then check that the unpacked extension is loaded in the intended profile. Click its toolbar icon to reconnect. A Pi session accepts only one browser profile connection at a time.
- **Protocol mismatch:** Reload the unpacked extension on the browser's extensions page and run `/reload` in Pi.
- **Debugger canceled:** Click the Pi Browser toolbar icon to allow actions again.
- **Socket path too long:** Use a shorter Pi agent directory.

## Development

From a clone, install the development dependencies and run:

```sh
npm ci
npm run check
npm test
npm run e2e
```

The end-to-end suite uses a temporary browser profile and downloads Chrome for Testing if it isn't cached. Set `E2E_BROWSER` to a compatible browser executable to use it instead.

## Check for updates

Check the published npm version:

```sh
npm view @dpaluy/pi-browser version
```

Update your installed packages, then run `/reload` in Pi and reload the unpacked browser extension from its extensions page. If the installed extension folder moved, load the folder shown by `/browser` again.

```sh
pi update --extensions
```

See [CHANGELOG.md](CHANGELOG.md) for changes.

## License

[MIT](LICENSE)

Inspired by [lwlee2608's Pi Browser](https://github.com/lwlee2608/pi-extensions/tree/main/packages/browser).

Supported by [Majestic Labs](https://majesticlabs.dev/).
