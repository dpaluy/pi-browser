import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext, SessionShutdownEvent,
  SessionStartEvent, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { browserExtension } from "../../src/index.ts";
import { EXTENSION_ID, installHost } from "../../src/install.ts";
import type { BrowserSettings } from "../../src/settings.ts";
import { extensionId, startBrowser } from "./harness.ts";

type LifecycleEvent = SessionStartEvent | SessionShutdownEvent;
type Handler = (event: LifecycleEvent, ctx: ExtensionContext) => unknown;
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
type Answer = string | boolean;

export function fakePi(name: string, cwd: string, signal?: AbortSignal) {
  const id = randomUUID();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const handlers = new Map<string, Set<Handler>>();
  const answers: Answer[] = [];
  const prompts: { title: string; options?: string[]; message?: string }[] = [];
  const notifications: { message: string; level?: string }[] = [];
  const unexpected: string[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); },
    on(event: string, handler: Handler) {
      const listeners = handlers.get(event) ?? new Set();
      handlers.set(event, listeners);
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
  } as ExtensionAPI;
  const takeAnswer = (title: string) => {
    const answer = answers.shift();
    if (answer === undefined) unexpected.push(`Unscripted prompt: ${title}`);
    assert.notEqual(answer, undefined, `Unscripted prompt: ${title}`);
    return answer;
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd,
    sessionManager: { getSessionId: () => id, getSessionName: () => name, getCwd: () => cwd },
    ui: {
      async select(title: string, options: string[]) {
        prompts.push({ title, options: [...options] });
        const answer = takeAnswer(title);
        if (typeof answer !== "string" || !options.includes(answer)) {
          unexpected.push(`Answer ${String(answer)} not in ${JSON.stringify(options)} for ${title}`);
          assert.fail(unexpected.at(-1));
        }
        return answer;
      },
      async confirm(title: string, message: string) {
        prompts.push({ title, message });
        const answer = takeAnswer(title);
        if (typeof answer !== "boolean") unexpected.push(`Expected a boolean answer for ${title}`);
        assert(typeof answer === "boolean", unexpected.at(-1));
        return answer;
      },
      notify(message: string, level?: string) { notifications.push({ message, level }); },
    },
  };
  const emit = async (event: LifecycleEvent) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx as unknown as ExtensionContext);
  };
  const script = async <T>(replies: Answer[], run: () => Promise<T>) => {
    assert.equal(answers.length, 0, "Overlapping Pi prompt scripts");
    answers.push(...replies);
    try {
      return await run();
    } finally {
      const unused = answers.splice(0);
      const errors = unexpected.splice(0);
      assert.deepEqual(errors, []);
      assert.deepEqual(unused, [], "Unused scripted answers");
    }
  };
  const tool = () => {
    const definition = tools.get("browser");
    assert(definition, "Pi did not register the browser tool");
    return definition;
  };
  let ended = false;
  return {
    pi, id, name, tool, prompts, notifications,
    start: () => emit({ type: "session_start", reason: "startup" }),
    shutdown: async () => {
      if (ended) return;
      ended = true;
      await emit({ type: "session_shutdown", reason: "quit" });
    },
    call(action: string, params: Record<string, unknown> = {}, replies: Answer[] = []) {
      return script(replies, async () => {
        let result: ToolResult;
        try {
          result = await tool().execute(randomUUID(), { ...params, action }, signal, undefined, ctx as unknown as ExtensionToolContext);
        } catch (error) {
          // Pi exposes thrown tool errors to the model as text as well.
          assert(error instanceof Error);
          result = { content: [{ type: "text", text: error.message }], details: undefined };
        }
        return {
          text: result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"),
          images: result.content.flatMap(part => part.type === "image" ? [part] : []),
        };
      });
    },
    command(name: string, args: string, replies: Answer[] = []) {
      const command = commands.get(name);
      assert(command, `Pi did not register /${name}`);
      return script(replies, () => command.handler(args, ctx as unknown as ExtensionCommandContext));
    },
  };
}

export async function setup(t: TestContext, settings?: Partial<BrowserSettings>, prepareProfile?: (profileDir: string) => Promise<void>) {
  assert.equal(EXTENSION_ID, extensionId);
  const browser = await startBrowser({
    signal: t.signal,
    beforeLaunch: async ({ agentDir, profileDir, socketsDir }) => {
      await writeFile(join(agentDir, "browser", "settings.json"), JSON.stringify({ ...settings, approveSites: settings?.approveSites ?? true }));
      await installHost([profileDir], socketsDir);
      await prepareProfile?.(profileDir);
    },
  });
  const sessions: ReturnType<typeof fakePi>[] = [];
  t.after(async () => {
    try {
      const results = await Promise.allSettled(sessions.map(session => session.shutdown()));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } finally {
      await browser.close();
    }
  });
  return {
    ...browser,
    async session(name = "Fixture operator") {
      const session = fakePi(name, browser.root, t.signal);
      sessions.push(session);
      await browserExtension({ agentDir: browser.agentDir, browserDirs: [browser.profileDir], connectTimeoutMs: 20_000 })(session.pi);
      await session.start();
      return session;
    },
  };
}
