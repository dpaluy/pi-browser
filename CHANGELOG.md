# Changelog

## 0.2.1 - 2026-11-24

### Changed

- Tab groups of unnamed sessions are titled with the project folder and a short session ID instead of the full ID.

## 0.2.0 - 2026-11-24

### Added

- Pluggable decision model for `find` and `target`: TypeSafe Jev, or any OpenAI-compatible server that returns `logprobs`, including open-source llama.cpp, vLLM, SGLang, and Ollama. Configure it with `decision` in `settings.json`; `/browser` shows the active one.
- `/browser <task>` runs a task in your browser, for example `/browser visit example.com and summarize it`.
- Click the toolbar icon to turn Pi Browser off or on. Off releases every tab, and the setting persists across browser restarts.
- The π toolbar icon shows whether Pi Browser is off, not connected, ready, in use by Pi sessions (with a count), or running an action.

### Changed

- Site approval is off by default; turn it on in `/browser settings`.
- An approved site now covers all of its subdomains, and approving `www.example.com` covers `example.com`.
- `/browser` waits for the extension to connect before reporting and shows the extension folder only while not connected.

## 0.1.0 - 2026-11-24

### Added

- Interactive `browser` tool for Chrome and Brave, with a background tab group per Pi session.
- `/browser` setup for the unpacked extension and local native messaging relay.
- Hostname approvals, a saved site list, upload confirmation, and configurable JavaScript confirmation.
- Accessibility snapshots with element refs, navigation and input actions, file uploads, and page waits.
- Screenshots and zoom, console and network diagnostics, and in-page JavaScript evaluation.
- Optional TypeSafe search and plain-language element targeting.
