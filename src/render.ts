import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const terminalText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

type CallArgs = { action?: string; ref?: number; url?: string; target?: string; query?: string };

export function renderCall(args: CallArgs, theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1]) {
  const hint = args.ref ? `[${args.ref}]` : args.url ?? args.target ?? args.query;
  return new Text(theme.fg("toolTitle", theme.bold("browser ")) + terminalText(`${args.action ?? ""}${hint ? ` ${hint}` : ""}`), 0, 0);
}

export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded }, theme) => {
  const output = terminalText(result.content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n"));
  const first = output.split("\n", 1)[0];
  const text = expanded || output === first ? output : `${first} …`;
  return new Text(result.isError ? theme.fg("error", text) : text, 0, 0);
};
