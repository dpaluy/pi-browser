# AGENTS.md

Pi Browser is a Pi extension (`@dpaluy/pi-browser`) that gives each Pi session a `browser` tool working in the
user's own Chrome or Brave, in a tab group of its own, without taking focus. Three parts talk over two local
channels:

```
Pi extension (src/, TypeScript) ── unix socket ── relay (host/relay.js) ── native messaging ── browser extension (extension/, MV3)
```

## Start here

- `docs/design.md` is the contract: wire protocol, every action's params and output, approval rules, the decision
  model interface, file layout. Change it first, then the code, and keep the two in agreement.
- `README.md` is for users. Update it whenever user-visible behavior, settings, or permissions change.
- `CHANGELOG.md` gets an entry for every user-visible change, under the upcoming version.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | Type-check (`tsc --noEmit`). |
| `npm test` | Unit tests (`node:test`, `test/*.test.ts`), including Pi loading the extension through its real loader. |
| `npm run e2e` | End-to-end suite in Chrome for Testing (downloaded on first run; `E2E_BROWSER=/path/to/browser` to use another). Runs serially; several minutes. |
| `npm run check:decision` | Real requests to the decision model configured in `~/.pi/agent/browser/settings.json` (or `TYPESAFE_API_KEY`) on a sample page; prints probabilities. Not part of `npm test`. |
| `scripts/icons.sh` | Regenerates `extension/icons/*.png` from `extension/icons/pi.svg` (needs `rsvg-convert`). |

Run all three checks before any commit that touches `src/`, `extension/`, or `host/`.

## Code rules

- TypeScript runs directly on Node 22.19+ via type stripping: no build step, no `enum`, no parameter
  properties, imports end in `.ts`.
- `extension/` is plain ES modules loaded unpacked; no bundler, no dependencies. `host/relay.js` is plain Node with
  no dependencies, because the browser starts it outside Pi.
- Never change the `key` in `extension/manifest.json`: it fixes the extension ID that the native host manifest
  allows.
- A change to messages between the parts bumps `PROTOCOL` in `src/server.ts`, `host/relay.js`, and
  `extension/transport.js` together; every side refuses a mismatched peer with an actionable error.
- The extension never activates a tab or focuses a window, and acts only in the requesting session's group.
- Secrets (API keys) come from environment variables named in settings, never from `settings.json` itself.
- No new npm dependencies without a clear need; prefer Node built-ins and Pi's own exports.

## Tests

- Test at the real boundary: a real Pi session, a real unix socket, the real relay, a real browser. Substitute
  only external services (for example a local HTTP server speaking a decision model API), and say what that
  leaves unverified.
- Never edit an expected result to match new behavior without first confirming the new behavior is intended.
- The e2e suite simulates toolbar clicks with `chrome.action.onClicked.dispatch()` inside the worker; a physical
  click and the debugger infobar's Cancel button are checked by hand.

## Releases

- Each released version is exactly **one commit** on `master`, titled `Pi Browser <version>`, tagged
  `v<version>`. Work in progress for the next version is folded into that version's single commit until it ships.
- Never amend, squash into, or force-push over a commit that has been released (published to npm or tagged).
- Bump the version in `package.json` (and `package-lock.json`), `extension/manifest.json`, and the relay's hello
  in `host/relay.js`; move the changelog entries under the new version and date.
- Before publishing: `npm pack --dry-run` to check the file list, then `npm publish` (public, scoped). Ask the
  maintainer before pushing, tagging, or publishing.
- Commits and PRs carry no co-author or attribution lines.
