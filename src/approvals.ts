import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { BrowserRequestError, type BrowserResult } from "./server.ts";
import type { SettingsStore } from "./settings.ts";

const choices = ["Allow once", "Allow for this session", "Always allow", "Deny"];

export function pageHost(url: string): string | undefined {
  try {
    const page = new URL(url);
    if (page.protocol === "https:" || page.protocol === "http:") return page.hostname;
  } catch { /* tabs can have no URL yet */ }
  return undefined;
}

export function approvalCall(store: SettingsStore, session: Set<string>, ui: Pick<ExtensionUIContext, "select">, always: string[], signal?: AbortSignal) {
  const once = new Set<string>();
  const persistent = new Set(always);
  const asked = new Set<string>();
  const allowed = () => [...new Set([...persistent, ...session, ...once])];
  async function run(send: (allowedHosts: string[]) => Promise<BrowserResult>, upload?: {
    destinations: Set<string>;
    confirm: (host: string) => Promise<void>;
  }): Promise<BrowserResult> {
    while (true) {
      signal?.throwIfAborted();
      const grants = allowed();
      const sent = upload ? grants.filter(host => upload.destinations.has(host)) : grants;
      try {
        return await send(sent);
      } catch (error) {
        if (!(error instanceof BrowserRequestError) || error.failure.code !== "needs-approval") throw error;
        const { host, acted } = error.failure;
        if (!host || pageHost(`https://${host}`) !== host || sent.includes(host)) throw error;
        if (upload && !acted && !upload.destinations.has(host)) {
          await upload.confirm(host);
          upload.destinations.add(host);
        }
        if (!grants.includes(host)) {
          if (asked.has(host)) throw error;
          asked.add(host);
          const answer = await ui.select(`Let the agent use ${host} in the browser?`, [...choices], { signal });
          signal?.throwIfAborted();
          switch (answer) {
            case "Allow once": once.add(host); break;
            case "Allow for this session": session.add(host); break;
            case "Always allow":
              await store.update(settings => { if (!settings.alwaysAllow.includes(host)) settings.alwaysAllow.push(host); });
              persistent.add(host);
              break;
            default: throw new Error(`The user did not allow the browser on ${host}.`);
          }
        }
        if (acted) throw new Error(`The browser action already ran and reached ${host}; it was not repeated. Read the page before continuing.`);
      }
    }
  }
  return { allowed, run };
}
