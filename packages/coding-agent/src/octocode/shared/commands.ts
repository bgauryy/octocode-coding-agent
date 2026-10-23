import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "../../core/extensions/index.ts";
import { withDialog } from "./locks.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

type NoticeLevel = "info" | "warning" | "error";

/**
	* Shows a notification. Octocode draws notify text as is, and notices carry file names, error messages, hook commands and
	* server text, so every notice goes through `sanitizeTerminalText` here. The one exception is the machine-read audit
	* relay (`childAuditMessage`), which a parent parses and never draws.
	*/
export function notify(ui: Pick<ExtensionUIContext, "notify">, text: string, level: NoticeLevel = "info"): void {
	ui.notify(sanitizeTerminalText(text), level);
}

/**
	* Shows a command's output. With a UI (TUI, and RPC, which forwards notifications) it is a notification. Print and
	* JSON modes have no UI (`notify` does nothing there) and Octocode reserves stdout for the final answer or the JSONL event
	* stream, so the text goes to stderr: visible in a terminal, and never mixed into `-p` output or `--mode json` records.
	*/
export function say(ctx: Pick<ExtensionContext, "hasUI" | "ui">, text: string, level: NoticeLevel = "info"): void {
	notify(ctx.ui, text, level);
	if (!ctx.hasUI) process.stderr.write(`${sanitizeTerminalText(text)}\n`);
}

/** A native command registered once under its canonical name. */
export interface Subcommand {
	description: string;
	aliases?: readonly string[];
	dialog?: "handler" | "interaction";
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
	complete?(prefix: string): AutocompleteItem[] | null;
}

const LEGACY_NAMES: Record<string, string> = { permission: "permissions", sessions: "resume", info: "status" };

export function legacyNativeCommandGuidance(args: string): string {
	const line = args.trim();
	const name = line.split(/\s+/, 1)[0] ?? "";
	const rest = line.slice(name.length).trimStart();
	if (!name || name === "help") return "Commands now have direct names: /status, /permissions, /resume, /agents, /hooks, /memory, /backlog, /rewind, /jobs, /archive, /api, /models, /trust and /mcp.";
	if (name === "mcp" && /^restart(?:\s|$)/.test(rest)) return "/octocode mcp restart moved to /mcp reconnect octocode. Run the new command to continue.";
	const target = name === "external" ? "agents external" : LEGACY_NAMES[name] ?? name;
	return `/octocode ${name} moved to /${target}${rest ? ` ${rest}` : ""}. Run the new command to continue.`;
}

export class Subcommands {
	private readonly entries = new Map<string, Subcommand>();
	add(name: string, command: Subcommand): void {
		this.entries.set(name, command);
	}
	get(name: string): Subcommand | undefined {
		return this.entries.get(name) ?? [...this.entries.values()].find(command => command.aliases?.includes(name));
	}
	has(name: string): boolean { return this.get(name) !== undefined; }
	list(): Array<[string, Subcommand]> { return [...this.entries].sort(([a], [b]) => a.localeCompare(b)); }
	help(): string { return this.list().map(([name, command]) => `/${name} — ${command.description}`).join("\n"); }
	complete(prefix: string): AutocompleteItem[] | null {
		const match = /^(\S+)\s+(.*)$/s.exec(prefix.trimStart());
		if (!match) return wordCompletions(this.list().map(([name]) => name), prefix);
		return this.get(match[1]!)?.complete?.(match[2]!.trimStart())?.map(item => ({...item, value: `${match[1]} ${item.value}`})) ?? null;
	}
	register(pi: ExtensionAPI, status?: () => string): void {
		if (status) {
			const details = this.get("status");
			this.add("status", {
				description: "Session status, skills and MCP connections",
				aliases: details?.aliases ?? ["info", "session"],
				dialog: "interaction",
				handler: async (args, ctx) => {
					say(ctx, status());
					await details?.handler(args, ctx);
				},
			});
		}
		for (const [name, command] of this.list()) {
			pi.registerCommand(name, {
				description: command.description,
				aliases: command.aliases,
				getArgumentCompletions: (prefix) => command.complete?.(prefix.trimStart()) ?? null,
				handler: (args, ctx) => command.dialog === "interaction"
					? command.handler(args.trim(), ctx)
					: withDialog(() => command.handler(args.trim(), ctx)),
			});
		}
		pi.on("input", async (event, ctx) => {
			const match = /^\/octocode(?:\s+(.*))?$/s.exec(event.text.trim());
			if (!match) return { action: "continue" };
			say(ctx, legacyNativeCommandGuidance(match[1] ?? ""), "warning");
			return { action: "handled" };
		});
	}
}

/** Completions for a fixed list of words, each optionally `[word, description]`. */
export function wordCompletions(words: Array<string | [string, string]>, prefix: string): AutocompleteItem[] | null {
	const items = words
		.map((entry): [string, string | undefined] => (typeof entry === "string" ? [entry, undefined] : entry))
		.filter(([word]) => word.startsWith(prefix))
		.map(([word, description]) => ({ value: word, label: word, ...(description ? { description } : {}) }));
	return items.length > 0 ? items : null;
}
