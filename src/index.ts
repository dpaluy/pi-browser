import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { decisionModel, type DecisionModel } from "./decision.ts";
import { detectBrowserDirs, EXTENSION_DIR, installHost } from "./install.ts";
import { SessionServer } from "./server.ts";
import { settingsStore } from "./settings.ts";
import { browserTool } from "./tool.ts";

export interface BrowserOptions {
  agentDir?: string;
  browserDirs?: string[];
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const STATUS_WAIT_MS = 5_000;

const interactive = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

export function groupName(session: Pick<ExtensionContext["sessionManager"], "getSessionName" | "getCwd">): string {
  const cwd = session.getCwd();
  return session.getSessionName() || Array.from(basename(cwd) || cwd).slice(0, 10).join("");
}

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
          const server = await SessionServer.open(sockets, id, () => groupName(ctx.sessionManager));
          return { server, hosts: new Set<string>() };
        })();
        sessions.set(id, session);
        void session.catch(() => { if (sessions.get(id) === session) sessions.delete(id); });
      }
      return session;
    };

    // The model and its tool schema are selected together from disk on startup (and on /reload).
    let configured: Promise<DecisionModel | undefined> | undefined;
    const model = () => configured ??= store.load().then(settings => decisionModel(settings, options.env ?? process.env));
    let registered = false;
    pi.on("session_start", async (_event, ctx) => {
      if (!interactive(ctx) || registered) return;
      pi.registerTool(browserTool({ store, start, connectTimeoutMs, requestTimeoutMs: options.requestTimeoutMs,
        decision: await model() }));
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
      description: "Do a task in your browser (/browser <task>), check the connection, or change settings (/browser settings, /browser sites).",
      getArgumentCompletions: prefix => ["settings", "sites"].filter(name => name.startsWith(prefix.trim()))
        .map(name => ({ value: name, label: name })),
      async handler(raw, ctx) {
        if (!interactive(ctx)) return;
        try {
          const task = raw.trim();
          switch (task) {
            case "": {
              const decision = await model();
              const installed = install();
              const manifests = await installed;
              const { server } = await start(ctx, installed);
              // The relay notices a new session socket shortly after it opens; report the status once it has.
              await server.connect(Math.min(connectTimeoutMs, STATUS_WAIT_MS)).catch(() => {});
              ctx.ui.notify([
                server.status,
                // The folder is only needed to load the extension, so it is shown only while it isn't connected.
                ...(server.connected ? [] : [`Extension folder: ${EXTENSION_DIR}`]),
                ...(manifests.length ? [] : ["No supported browser data folders were found."]),
                `Decision model: ${decision?.label ?? "none (find and target are off)"}`,
              ].join("\n"), "info");
              break;
            }
            case "settings": {
              const { approveSites, confirmEval } = await store.load();
              const sites = approveSites ? "Stop asking before new sites" : "Ask before the agent uses a new site";
              const evals = confirmEval ? "Run page JavaScript without asking" : "Ask before running page JavaScript";
              const choice = await ctx.ui.select([
                `Site approval is ${approveSites ? "on" : "off"}; eval confirmation is ${confirmEval ? "on" : "off"}.`,
              ].join("\n"), [sites, evals, "Cancel"]);
              if (choice === sites) {
                await store.update(settings => { settings.approveSites = !approveSites; });
                ctx.ui.notify(approveSites ? "The browser now works on any site without asking."
                  : "Pi now asks before the browser acts on a site you haven't allowed.", "info");
              } else if (choice === evals) {
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
            default: {
              const prompt = `Use the browser tool, which works in my own Chrome or Brave, for this: ${task}`;
              if (ctx.isIdle()) pi.sendUserMessage(prompt);
              else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
            }
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  };
}

export default browserExtension();
