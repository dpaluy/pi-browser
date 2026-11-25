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

const exactOnly = (host: string) => host === "localhost" || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);

// A grant covers its host and every subdomain; "*" covers every web host; localhost and IP addresses match only
// exactly. Mirrors coversHost in extension/allowed.js.
export function covers(grants: Iterable<string>, host: string): boolean {
  host = host.toLowerCase();
  for (let grant of grants) {
    grant = grant.toLowerCase();
    if (grant === "*" || grant === host) return true;
    if (!exactOnly(host) && !exactOnly(grant) && host.endsWith(`.${grant}`)) return true;
  }
  return false;
}

// Approving www.example.com approves example.com and all of its subdomains.
export const grantFor = (host: string) => host.toLowerCase().replace(/^www\./, "");

export function approvalCall(store: SettingsStore, session: Set<string>, ui: Pick<ExtensionUIContext, "select">, always: string[], signal?: AbortSignal, approveSites = true) {
  const once = new Set<string>();
  const persistent = new Set(always);
  const asked = new Set<string>();
  const allowed = () => approveSites ? [...new Set([...persistent, ...session, ...once])] : ["*"];
  async function run(send: (allowedHosts: string[]) => Promise<BrowserResult>, upload?: {
    destinations: Set<string>;
    confirm: (host: string) => Promise<void>;
  }): Promise<BrowserResult> {
    while (true) {
      signal?.throwIfAborted();
      const grants = allowed();
      // An upload may reach only hosts the user confirmed these files for, and only if they are allowed.
      const sent = upload ? [...upload.destinations].filter(host => covers(grants, host)) : grants;
      try {
        return await send(sent);
      } catch (error) {
        if (!(error instanceof BrowserRequestError) || error.failure.code !== "needs-approval") throw error;
        const { host, acted } = error.failure;
        if (!host || pageHost(`https://${host}`) !== host || covers(sent, host)) throw error;
        if (upload && !acted && !upload.destinations.has(host)) {
          await upload.confirm(host);
          upload.destinations.add(host);
        }
        if (!covers(grants, host)) {
          if (asked.has(host)) throw error;
          asked.add(host);
          const answer = await ui.select(`Let the agent use ${host} in the browser?`, [...choices], { signal });
          signal?.throwIfAborted();
          const grant = grantFor(host);
          switch (answer) {
            case "Allow once": once.add(grant); break;
            case "Allow for this session": session.add(grant); break;
            case "Always allow":
              await store.update(settings => { if (!settings.alwaysAllow.includes(grant)) settings.alwaysAllow.push(grant); });
              persistent.add(grant);
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
