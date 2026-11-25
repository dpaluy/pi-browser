# Pi Browser

[![npm version](https://img.shields.io/npm/v/@dpaluy/pi-browser.svg)](https://www.npmjs.com/package/@dpaluy/pi-browser)

Let Pi work in your signed-in Chrome or Brave. Each Pi session uses its own tab group without bringing it to the front.

## Install

Requires Pi running on Node.js 22.19 or later on macOS or Linux, and a browser based on Chromium 125 or later. Pi running on Bun or as a standalone executable is not supported.

```sh
pi install npm:@dpaluy/pi-browser
```

1. Restart Pi or run `/reload`, then run `/browser` in an interactive Pi session. It installs or refreshes the native messaging host for detected browsers and shows the connection status, plus the extension folder while the extension isn't connected.
2. In the browser profile you want Pi to use, open `chrome://extensions` or `brave://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extension folder shown by `/browser`, then run `/browser` again to check the status.

## Use

No special command is needed. Every interactive Pi session has the `browser` tool, so you can ask in plain words:

```text
Open majesticlabs.dev and tell me what the company does
Check my GitHub notifications
Fill in the contact form on example.com with my details
```

Pi uses the browser when you ask to visit, open, or act on a website, or when a page needs your login. The model still chooses its tools, though, and for a general question it may use web search or fetch instead. To make sure the task runs in your browser, start it with `/browser`:

```text
/browser visit majesticlabs.dev and explain what this company does
```

Mentioning "my browser", "in Chrome", or "logged in", or giving a URL, also helps.

| Command | What it does |
| --- | --- |
| `/browser <task>` | Do the task in your browser. |
| `/browser` | Set up the connection and show its status. |
| `/browser settings` | Turn site approval and JavaScript confirmation on or off. |
| `/browser sites` | List and remove sites you've always allowed. |

The agent works in its own tab group, titled **pi · <session name>** or, for a session you haven't named, **pi · <project folder> · <first 4 characters of the session ID>**, in the background, without taking focus. The toolbar icon turns orange while it acts; click the icon to turn Pi Browser off at any time.

### Actions

The agent opens HTTP and HTTPS pages. `navigate` creates the first tab in the session's group. The tabs stay open when the session ends. Tab actions use the session's current tab unless you pass `tabId`.

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
| `network` | — | Show recent request methods, statuses, types, and URLs, without headers or bodies. With site approval on, requests to or from sites you haven't approved are only counted. |
| `eval` | `code` | Run JavaScript in the page. Pi asks for confirmation by default; `/browser settings` toggles it. |
| `find` | `query` | Search the page snapshot by meaning. Requires a [decision model](#decision-model-optional). |

Take a screenshot before using points (`[x, y]`) or a zoom region (`[x, y, width, height]`). These coordinates are in pixels of the last screenshot or zoom. If a `ref` goes stale, run `read` again. `find` and `target` need a decision model; see the next section.

### Decision model (optional)

A **decision model** is a second, small model that Pi Browser asks short, structured questions about the page, such as "which of these lines is the Save button?" or "is the shipping price on this page?". It answers with a **probability** for each option rather than with text. It is separate from the model you chat with: the agent keeps its context for the task, and the decision model only does the matching.

It powers two features, both matching by meaning rather than exact words:

- **`find`** with a `query` such as `"shipping cost"` or `"is there a cancel subscription option?"` returns the best-matching lines of the page with a match percentage, and says whether the answer is likely on the page at all.
- **`target`** names an element in plain language, such as `"the Save button in the billing form"`, in place of a numeric `ref` on `click`, `type`, `keys`, `select`, `scroll`, `upload`, and each `fill` field.

Because the answers are probabilities, Pi can tell a sure match from a guess. It acts on a `target` only when one element clearly wins: the model is at least 60% sure the element is on the page, at least 70% sure of its pick, the runner-up scores under half the winner, and the description isn't likely to fit several elements. Otherwise it does nothing and shows the closest candidates, so the agent can describe the element better or fall back to `read`.

Without a decision model, `find` and `target` don't appear in the tool at all, and everything else works the same.

#### Providers

| Provider | Works with | How it gets probabilities |
| --- | --- | --- |
| `typesafe` | [TypeSafe](https://typesafe.ai) Jev ([API docs](https://docs.typesafe.ai/api)) | Built for this: one request per page chunk answers every question. |
| `openai` | Any OpenAI-compatible `/chat/completions` server that returns `logprobs`, including the open-source servers llama.cpp (`llama-server`), vLLM, SGLang, and Ollama, and hosted APIs such as OpenAI | From the token probabilities of a one-word answer. One request per question. |

LM Studio's OpenAI-compatible endpoint doesn't return `logprobs`, so it doesn't work.

#### Set it up

Add `decision` to `~/.pi/agent/browser/settings.json`, then run `/reload` in Pi. `/browser` shows which decision model is active.

**TypeSafe:** set your key before starting Pi. With no `decision` setting, `TYPESAFE_API_KEY` alone turns it on.

```sh
export TYPESAFE_API_KEY=...
```

**An open-source model with llama.cpp:**

```sh
llama-server -hf Qwen/Qwen3-1.7B-GGUF:Q8_0 --port 8080 --chat-template-kwargs '{"enable_thinking":false}'
```

```json
{
  "decision": { "provider": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3-1.7b" }
}
```

**A hosted or authenticated server:** name the environment variable that holds the key. Keys are never stored in `settings.json`.

```json
{
  "decision": { "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini", "apiKeyEnv": "OPENAI_API_KEY" }
}
```

| Field | Meaning |
| --- | --- |
| `provider` | `typesafe` or `openai`. |
| `baseUrl` | `openai` only: the server's API base, including `/v1`. |
| `model` | The model name the server expects. Optional for `typesafe` (default `jev-latest`). |
| `apiKeyEnv` | The environment variable holding the API key. Defaults to `TYPESAFE_API_KEY` for `typesafe`; for `openai`, no key is sent unless you set it. |

#### Choose and check a model

For `openai`, use a model that answers directly. Turn thinking off for reasoning models, because Pi reads only the first tokens of the answer. Small models vary a lot: in our tests Qwen3 1.7B matched every target in a sample form with over 99% confidence, while Gemma 3 1B missed them all. Pi then did nothing rather than click the wrong element.

To check your configured model on a sample page before relying on it, run this from a clone of [the repository](https://github.com/dpaluy/pi-browser) (it reads the same `settings.json`):

```sh
npm install && npm run check:decision
```

It prints the probabilities for three element targets and one `find` query and fails unless all four are correct. Even a good model can land near the 70% bar on a vague description; TypeSafe Jev, for example, sometimes scores "Create account button" at about 60% because the page also has "Delete" buttons.

For what is sent to the decision model, see [Privacy](#privacy).

### Toolbar icon

| Icon | Meaning |
| --- | --- |
| Gray π | Not connected to Pi, or an error. Hover over the icon to see why. |
| Blue π | Connected; no Pi session is attached yet. |
| Green π with a number | Pi sessions are attached. The badge shows how many. |
| Orange π with a number | The agent is running a browser action. |
| Dark π with a coral slash | Turned off. |

Click the icon to turn Pi Browser off: the agent can't use the browser until you click it again, and the browser's "started debugging" bar goes away. The setting is kept across browser restarts. While it's off, Pi tells the agent to ask you to turn it back on.

## Site approval

By default the agent can use any site without asking. To approve sites yourself, run `/browser settings` and choose **Ask before the agent uses a new site**.

With site approval on, Pi asks the first time the agent acts on a site: **Allow once** (for that tool call), **Allow for this session**, **Always allow**, or **Deny**. Approving a site covers all of its pages and subdomains: approving `www.example.com` covers `example.com`, `shop.example.com`, and so on. Use `/browser sites` to remove a saved approval. The `tabs` action doesn't prompt; for unapproved sites it shows the hostname, not the title or full URL.

Uploads always ask you to confirm the files and the site they go to, and `eval` asks before running page JavaScript unless you turn that off in `/browser settings`.

An action such as a click or navigation may already have reached a new host when Pi asks. Pi withholds the page result and doesn't repeat the action, even if you approve the new host. Read the page before continuing. Input directed into a cross-site frame can require separate approval for that frame's host.

## Privacy

What leaves your machine:

- Your model provider receives browser tool output, which can include page text, URLs, diagnostic output, local screenshot paths, and screenshots.
- With a decision model configured, `find` and `target` send it the lookup text and the page's accessibility snapshot text, including the tab title and URL, but never screenshots. A local server such as llama.cpp keeps this on your machine; TypeSafe or a hosted API receives it.
- The site can receive what the agent types, fills in, or uploads, just as if you did it in the browser.

What is stored locally:

- `~/.pi/agent/browser/settings.json` stores `approveSites` (whether to ask before new sites), `alwaysAllow` (saved sites), `confirmEval` (whether to ask before running page JavaScript), and `decision` (the decision model, without keys). If `PI_CODING_AGENT_DIR` is set, the `browser` directory is under that path instead.
- Pi saves a local JPEG for each screenshot or zoom in a `pi-browser-*` folder under the system temp directory. Pi does not delete these copies.
- The relay and Pi communicate over local Unix sockets in `browser/sockets/` under the Pi agent directory. Pi closes the session socket on shutdown.

## Security

The extension declares no host permissions. It holds these permissions:

- `debugger` to read and interact with tabs in the session's group, capture screenshots, and collect diagnostics.
- `nativeMessaging` to connect to the local relay. The native host manifest allows only the Pi Browser extension ID.
- `tabs` to inspect tab metadata and manage tabs, and `tabGroups` to track and label session groups.
- `storage` to keep group state in browser session storage and the on/off setting in local storage.
- `alarms` to retry the native connection when disconnected.

## Limits

- Windows is not supported. The installer looks for standard browser data folders on macOS and Linux; it does not set up Snap or Flatpak browsers.
- On macOS, Brave looks for the per-user native host manifest in its real browser data folder (`~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`), not in a temporary profile passed via `--user-data-dir`.
- `read` includes same-origin frames but does not read cross-site frame contents. Screenshots can still show what's visible in the viewport.
- The tool does not operate native dialogs or file pickers. Answer JavaScript dialogs and complete CAPTCHAs yourself. `upload` sets a web page's file input without operating the native picker.
- The tool is available in interactive Pi sessions, not print or RPC mode.

## Troubleshooting

- **Not connected:** Open the browser once so its data folder exists, run `/browser`, then check that the unpacked extension is loaded and switched on in the intended profile. A Pi session accepts only one browser profile connection at a time.
- **Protocol mismatch:** Reload the unpacked extension on the browser's extensions page and run `/reload` in Pi.
- **Turned off:** Click the Pi Browser toolbar icon to turn it on.
- **Debugger canceled:** Click the Pi Browser toolbar icon twice (off, then on) to allow actions again.
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
