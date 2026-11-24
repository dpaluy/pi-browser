import { stat, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, formatSize, truncateHead, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { approvalCall, pageHost } from "./approvals.ts";
import { renderCall, renderResult, terminalText } from "./render.ts";
import type { SessionServer } from "./server.ts";
import type { SettingsStore } from "./settings.ts";
import { find, matchTargets } from "./targets.ts";
import { view } from "./view.ts";

const actionFields = {
  status: [], tabs: [], navigate: ["url", "newTab"], back: [], forward: [], reload: [], close: [],
  read: ["offset", "interactive"], click: ["ref", "target", "point", "button", "clickCount"],
  hover: ["point"], drag: ["point", "to"], type: ["ref", "target", "text"], keys: ["ref", "target", "keys"],
  scroll: ["ref", "target", "point", "delta"], fill: ["fields"], select: ["ref", "target", "values"],
  upload: ["ref", "target", "paths"], wait: ["text", "gone", "timeout"], screenshot: [], zoom: ["region"],
  console: [], network: [], eval: ["code"], find: ["query"],
} as const;
type Action = keyof typeof actionFields;
const actions = Object.keys(actionFields) as Action[];
const optional = Type.Optional;
const coordinates = (length: number, description: string) => Type.Array(Type.Number(), { minItems: length, maxItems: length, description });

export function browserSchema(jev: boolean) {
  const target = optional(Type.String({ description: "Describe an element by its role, name, or purpose instead of using ref." }));
  const schema = Type.Object({
    action: Type.Enum(actions.filter(action => jev || action !== "find"), { type: "string" }),
    tabId: optional(Type.Integer({ description: "Defaults to this session’s current tab." })),
    url: optional(Type.String()), newTab: optional(Type.Boolean()),
    offset: optional(Type.Integer({ description: "Zero-based snapshot line offset for read." })),
    interactive: optional(Type.Boolean({ description: "Show only the tab header and lines with refs." })),
    ref: optional(Type.Integer({ description: "Numeric [ref] from read; takes precedence over target." })),
    target,
    point: optional(coordinates(2, "[x, y] in the last screenshot’s pixels.")), to: optional(coordinates(2, "Drag destination [x, y] in the last screenshot’s pixels.")),
    button: optional(Type.Enum(["left", "middle", "right", "back", "forward"], { type: "string" })), clickCount: optional(Type.Integer()),
    text: optional(Type.String()), keys: optional(Type.String()),
    delta: optional(coordinates(2, "Scroll delta [dx, dy] in CSS pixels.")),
    fields: optional(Type.Array(Type.Object({ ref: optional(Type.Integer()), target, value: Type.String() }, { additionalProperties: false }))),
    values: optional(Type.Array(Type.String())), paths: optional(Type.Array(Type.String())),
    gone: optional(Type.Union([Type.Boolean(), Type.String()], { description: "Wait for text to disappear (true with text, or supply the text here)." })), timeout: optional(Type.Number({ description: "Wait timeout in milliseconds (default 10000)." })),
    region: optional(coordinates(4, "[x, y, width, height] in the last screenshot’s pixels.")),
    code: optional(Type.String()),
    query: optional(Type.String({ description: "Page content to find semantically." })),
  }, { additionalProperties: false });
  if (!jev) {
    const { target, query, fields, ...common } = schema.properties;
    const refFields = optional(Type.Array(Type.Omit(fields.items, ["target"])));
    // This schema accepts a subset of Input; the extra inputs are optional.
    return Type.Object({ ...common, fields: refFields }, { additionalProperties: false }) as typeof schema;
  }
  return schema;
}

type Input = Static<ReturnType<typeof browserSchema>>;
const given = (value: unknown) => value !== undefined && value !== 0 && value !== "" && (!Array.isArray(value) || value.length > 0);

export function normalizeParams(input: unknown, jev: boolean): Input {
  const args = input as Input | null;
  const action = args?.action;
  if (!args || typeof action !== "string" || !Object.hasOwn(actionFields, action) || (action === "find" && !jev)) {
    throw new Error("Choose a valid browser action.");
  }
  const result: Record<string, unknown> = { action };
  for (const key of ["tabId", ...actionFields[action as Action]] as const) {
    if (key === "target" && (!jev || given(args.ref))) continue;
    const value = args[key];
    if (!given(value)) continue;
    if (key === "fields" && Array.isArray(value)) {
      result.fields = value.map(field => {
        if (!field || typeof field !== "object") return field;
        if (given(field.ref)) return { ref: field.ref, value: field.value };
        if (jev && given(field.target)) return { target: field.target, value: field.value };
        return { value: field.value };
      });
    } else {
      result[key] = value;
    }
  }
  if ((action === "click" || action === "scroll") && (result.ref || result.target)) {
    delete result.point;
    delete result.delta;
  }
  return result as Input;
}

const invisible = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export function evalLines(code: string): number {
  const lines = code.split("\n");
  if (!code.trim()) throw new Error("Browser eval requires code.");
  if (lines.length > 20 || [...code].length > 1500) throw new Error("Browser eval code is limited to 20 lines and 1,500 characters.");
  if (invisible.test(code.replace(/[\n\t]/g, ""))) throw new Error("Browser eval code contains invisible or control characters.");
  if (lines.some((line, i) => i > 0 && !line.trim() && !lines[i - 1].trim())) {
    throw new Error("Browser eval code cannot contain two blank lines in a row.");
  }
  return lines.length;
}

export async function uploadPaths(paths: string[], cwd: string): Promise<string[]> {
  if (!paths.length) throw new Error("Browser upload requires one or more file paths.");
  return Promise.all(paths.map(async path => {
    if (!path) throw new Error("Browser upload paths cannot be empty.");
    const absolute = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(cwd, path);
    const file = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    });
    if (!file?.isFile()) throw new Error(`Not a file: ${absolute}`);
    return absolute;
  }));
}

function validate({ action, ...params }: Input) {
  const element = params.ref || params.target;
  const requireParam = (condition: unknown, required: string) => {
    if (!condition) throw new Error(`Browser ${action} requires ${required}.`);
  };
  switch (action) {
    case "navigate": requireParam(params.url && pageHost(params.url), "an HTTP or HTTPS URL"); break;
    case "click": requireParam(element || params.point, "an element or point"); break;
    case "hover": requireParam(params.point, "a point"); break;
    case "drag": requireParam(params.point && params.to, "point and to"); break;
    case "type": requireParam(params.text, "text"); break;
    case "keys": requireParam(params.keys, "keys"); break;
    case "scroll": requireParam(element || (params.point && params.delta), "an element or a point and delta"); break;
    case "fill": requireParam(params.fields?.length && params.fields.every(field => (field.ref || field.target) && typeof field.value === "string"), "fields with an element and value"); break;
    case "select": requireParam(element && params.values, "an element and values"); break;
    case "upload": requireParam(element && params.paths, "an element and file paths"); break;
    case "zoom": requireParam(params.region, "a region"); break;
    case "find": requireParam(params.query, "a query"); break;
  }
}

interface BrowserSession { server: SessionServer; hosts: Set<string> }
interface ToolOptions {
  key?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs: number;
  store: SettingsStore;
  start: (ctx: Pick<ExtensionContext, "sessionManager">) => Promise<BrowserSession>;
}

export function browserTool(options: ToolOptions) {
  const jev = Boolean(options.key);
  return defineTool({
    name: "browser",
    label: "Browser",
    description: `Use the user's Chrome or Brave in this session’s tab group, without taking focus. Navigate to open the first tab; read for the accessibility snapshot and [refs], or screenshot for pixel coordinates (zoom uses [x, y, width, height]). Only HTTP(S) hosts approved by the user are available. Use read offset to continue after ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, or interactive to show only refs.${jev ? " Use find with query to look for page content, or target instead of a ref to describe an element." : ""}`,
    promptSnippet: "Browse in the current session’s Chrome or Brave tab group.",
    parameters: browserSchema(jev),
    prepareArguments: args => normalizeParams(args, jev),
    executionMode: "sequential",
    renderCall,
    renderResult,
    async execute(_id, input, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
      if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("The browser tool requires an interactive Pi session.");
      signal?.throwIfAborted();
      const cleaned = normalizeParams(input, jev);
      validate(cleaned);
      const { action, offset, interactive, query, ...params } = cleaned;
      const settings = await options.store.load();
      if (action === "eval") {
        const code = params.code ?? "";
        const lines = evalLines(code);
        if (settings.confirmEval) {
          const run = `Run all ${lines} lines`;
          const answer = await ctx.ui.select(`Run this browser code?\n${code}`, [run, "Cancel"], { signal });
          signal?.throwIfAborted();
          if (answer !== run) throw new Error("The user did not allow browser eval.");
        }
      }
      if (action === "upload") params.paths = await uploadPaths(params.paths!, ctx.cwd);
      const { server, hosts } = await options.start(ctx);
      await server.connect(options.connectTimeoutMs, signal);
      const approval = approvalCall(options.store, hosts, ctx.ui, settings.alwaysAllow, signal);
      const request = (method: string, data: object, allowed: string[]) => server.request(method, data, allowed,
        options.requestTimeoutMs ?? (method === "wait" ? (params.timeout ?? 10_000) + 5_000 : 60_000), signal);
      const current = params.tabId === undefined ? {} : { tabId: params.tabId };
      const read = () => approval.run(allowed => request("read", current, allowed));
      const tabs = (scope = {}) => request("tabs", scope, approval.allowed());

      if (action === "tabs") {
        const result = await tabs(current);
        const allowed = new Set(approval.allowed());
        const listing = (result.tabs ?? []).map(tab => {
          const host = pageHost(tab.url);
          if (!host || !allowed.has(host)) return `Tab ${tab.id}: ${host ?? "(no web host)"}`;
          return `Tab ${tab.id}: ${tab.title} <${tab.url}>${tab.current ? " (current)" : ""}`;
        });
        return textResult([...listing, `${result.others ?? 0} other tabs are not in your group.`].join("\n"));
      }
      if (action === "find") return textResult(await find((await read()).text ?? "", query!, options.key!, signal));

      let upload: Parameters<typeof approval.run>[1];
      if (action === "upload") {
        const tab = (await tabs()).tabs?.find(tab => params.tabId === undefined ? tab.current : tab.id === params.tabId);
        const host = tab && pageHost(tab.url);
        if (!tab || !host) throw new Error("No HTTP or HTTPS tab is available for browser upload.");
        params.tabId = tab.id;
        upload = {
          destinations: new Set(),
          async confirm(host) {
            const files = params.paths!.map(path => JSON.stringify(path)).join(", ");
            const accepted = await ctx.ui.confirm(`Let the agent attach ${files} to a page on ${host}?`, params.paths!.map(terminalText).join("\n"), { signal });
            signal?.throwIfAborted();
            if (!accepted) throw new Error(`The user did not allow the browser upload on ${host}.`);
          },
        };
        await upload.confirm(host);
        upload.destinations.add(host);
      }

      const targetFields = [params, ...(params.fields ?? [])].filter(field => field.target !== undefined);
      const notes: string[] = [];
      if (targetFields.length) {
        const scope = params.tabId === undefined ? {} : { tabId: params.tabId };
        const snapshot = await approval.run(allowed => request("read", scope, allowed));
        const text = snapshot.text ?? "";
        const snapshotTab = /^Tab (\d+):/.exec(text);
        if (params.tabId === undefined && snapshotTab) params.tabId = Number(snapshotTab[1]);
        const hits = await matchTargets(text, targetFields.map(field => field.target!), options.key!, signal);
        hits.forEach(({ ref, note }, i) => {
          targetFields[i].ref = ref;
          delete targetFields[i].target;
          notes.push(note);
        });
      }
      const result = await approval.run(allowed => request(action, params, allowed), upload);
      const output = action === "read" ? view(result.text ?? "", offset, interactive) : result.text ?? "";
      const text = [...notes, output].filter(Boolean).join("\n");
      if (!result.image) return textResult(text, action !== "read");
      const { data, mimeType, width, height } = result.image;
      if (typeof data !== "string" || mimeType !== "image/jpeg" || !Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error("Invalid image from the Pi Browser extension.");
      }
      const folder = await mkdtemp(join(tmpdir(), "pi-browser-"));
      const path = join(folder, `${action}.jpg`);
      const bytes = Buffer.from(data, "base64");
      await writeFile(path, bytes, { mode: 0o600 });
      const outputResult = textResult([text, `Saved ${path} (${width} × ${height}, ${formatSize(bytes.length)}).`].filter(Boolean).join("\n"));
      outputResult.content.push({ type: "image", data, mimeType });
      return outputResult;
    },
  });
}

function textResult(text: string, truncate = true): AgentToolResult<undefined> {
  const output = truncate ? truncateHead(text) : undefined;
  return { content: [{ type: "text", text: output?.truncated ? `${output.content}\n\n[Output truncated.]` : text }], details: undefined };
}
