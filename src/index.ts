import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { detectBrowserDirs, EXTENSION_DIR, EXTENSION_ID, installHost } from "./install.ts";
import { SessionServer } from "./server.ts";
import { settingsStore } from "./settings.ts";
import { browserTool } from "./tool.ts";

export interface BrowserOptions {
  agentDir?: string;
  browserDirs?: string[];
  typesafeKey?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const interactive = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

export function browserExtension(options: BrowserOptions = {}): (pi: ExtensionAPI) => void {
  return pi => {
    const data = join(options.agentDir ?? getAgentDir(), "browser");
    const sockets = join(data, "sockets");
    const store = settingsStore(data);
    const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    const sessions = new Map<string, Promise<{ server: SessionServer; hosts: Set<string> }>>();
    const install = () => installHost(options.browserDirs ?? detectBrowserDirs(), sockets);
    const start = (ctx: Pick<ExtensionContext, "sessionManager">, installed?: Promise<string[]>) => {
      const id = ctx.sessionManager.getSessionId();
      let session = sessions.get(id);
      if (!session) {
        session = (async () => {
          await (installed ?? install());
          const server = await SessionServer.open(sockets, id, () => ctx.sessionManager.getSessionName() || id);
          return { server, hosts: new Set<string>() };
        })();
        sessions.set(id, session);
        void session.catch(() => { if (sessions.get(id) === session) sessions.delete(id); });
      }
      return session;
    };

    let registered = false;
    pi.on("session_start", (_event, ctx) => {
      if (!interactive(ctx) || registered) return;
      pi.registerTool(browserTool({ store, start, connectTimeoutMs, requestTimeoutMs: options.requestTimeoutMs,
        key: options.typesafeKey ?? process.env.TYPESAFE_API_KEY }));
      registered = true;
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const pending = sessions.get(id);
      sessions.delete(id);
      const session = await pending?.catch(() => undefined);
      await session?.server.close();
    });
    pi.registerCommand("browser", {
      description: "Install and connect Pi Browser, change eval confirmation, or manage allowed sites.",
      async handler(raw, ctx) {
        if (!interactive(ctx)) return;
        try {
          switch (raw.trim()) {
            case "": {
              const installed = install();
              const manifests = await installed;
              const { server } = await start(ctx, installed);
              ctx.ui.notify([
                `Extension folder: ${EXTENSION_DIR}`,
                `Extension ID: ${EXTENSION_ID}`,
                server.status,
                ...(manifests.length ? [] : ["No supported browser data folders were found."]),
              ].join("\n"), "info");
              break;
            }
            case "settings": {
              const { confirmEval } = await store.load();
              const toggle = confirmEval ? "Turn off eval confirmation" : "Turn on eval confirmation";
              if (await ctx.ui.select(`Browser eval confirmation is ${confirmEval ? "on" : "off"}.`, [toggle, "Cancel"]) === toggle) {
                await store.update(settings => { settings.confirmEval = !confirmEval; });
                ctx.ui.notify(`Browser eval confirmation is now ${confirmEval ? "off" : "on"}.`, "info");
              }
              break;
            }
            case "sites": {
              const { alwaysAllow } = await store.load();
              if (!alwaysAllow.length) {
                ctx.ui.notify("No browser sites are always allowed.", "info");
                break;
              }
              const host = await ctx.ui.select("Remove an always-allowed browser site?", [...alwaysAllow, "Cancel"]);
              if (host && alwaysAllow.includes(host)) {
                await store.update(settings => { settings.alwaysAllow = settings.alwaysAllow.filter(site => site !== host); });
                ctx.ui.notify(`Removed ${host} from always-allowed browser sites.`, "info");
              }
              break;
            }
            default: ctx.ui.notify("Usage: /browser [settings|sites]", "warning");
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default browserExtension();
