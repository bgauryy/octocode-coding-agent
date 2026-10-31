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
	/** One sentence of at most 50 characters; usage goes in `argumentHint`. */
	description: string;
	/** Usage after the command name, such as `[all|<query>]`. */
	argumentHint?: string;
	dialog?: "handler" | "interaction";
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
	complete?(prefix: string): AutocompleteItem[] | null;
}

/** What to run instead of `/octocode <args>`; `commands` are the registered names, so the list cannot go stale. */
export function legacyNativeCommandGuidance(args: string, commands: readonly string[] = []): string {
	const line = args.trim();
	const name = line.split(/\s+/, 1)[0] ?? "";
	const rest = line.slice(name.length).trimStart();
	if (name === "mcp" && /^restart(?:\s|$)/.test(rest))
		return "/octocode mcp restart moved to /mcp reconnect octocode. Run the new command to continue.";
	if (name === "external")
		return `/octocode external moved to /agents external${rest ? ` ${rest}` : ""}. Run the new command to continue.`;
	if (name === "mcp" || commands.includes(name))
		return `/octocode ${name} moved to /${name}${rest ? ` ${rest}` : ""}. Run the new command to continue.`;
	// `/mcp` belongs to the MCP extension, not to these subcommands.
	const names = [...new Set([...commands, "mcp"])].sort().map((command) => `/${command}`);
	const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
	return `Commands now have direct names: ${list}.`;
}

export class Subcommands {
	private readonly entries = new Map<string, Subcommand>();
	add(name: string, command: Subcommand): void {
		this.entries.set(name, command);
	}
	get(name: string): Subcommand | undefined {
		return this.entries.get(name);
	}
	has(name: string): boolean {
		return this.get(name) !== undefined;
	}
	list(): Array<[string, Subcommand]> {
		return [...this.entries].sort(([a], [b]) => a.localeCompare(b));
	}
	help(): string {
		return this.list()
			.map(([name, command]) => `/${[name, command.argumentHint].filter(Boolean).join(" ")} — ${command.description}`)
			.join("\n");
	}
	complete(prefix: string): AutocompleteItem[] | null {
		const match = /^(\S+)\s+(.*)$/s.exec(prefix.trimStart());
		if (!match)
			return wordCompletions(
				this.list().map(([name]) => name),
				prefix,
			);
		return (
			this.get(match[1])
				?.complete?.(match[2].trimStart())
				?.map((item) => ({ ...item, value: `${match[1]} ${item.value}` })) ?? null
		);
	}
	register(api: ExtensionAPI): void {
		for (const [name, command] of this.list()) {
			api.registerCommand(name, {
				description: command.description,
				...(command.argumentHint && { argumentHint: command.argumentHint }),
				getArgumentCompletions: (prefix) => command.complete?.(prefix.trimStart()) ?? null,
				handler: async (args, ctx) => {
					if (name === "octocode" && this.retiredForm(command, args)) {
						say(ctx, this.guidance(args), "warning");
						return;
					}
					return command.dialog === "interaction"
						? command.handler(args.trim(), ctx)
						: withDialog(() => command.handler(args.trim(), ctx));
				},
			});
		}
		// Reached when commands are not dispatched first (prompt templates off) or `/octocode` is not registered.
		api.on("input", async (event, ctx) => {
			const match = /^\/octocode(?:\s+(.*))?$/s.exec(event.text.trim());
			if (!match) return { action: "continue" };
			// Bare /octocode is now the live board; only the retired namespaced form needs migration guidance.
			if (!match[1]?.trim() && this.has("octocode")) return { action: "continue" };
			say(ctx, this.guidance(match[1] ?? ""), "warning");
			return { action: "handled" };
		});
	}
	/** What to run instead of `/octocode <args>`, naming the registered direct commands. */
	private guidance(args: string): string {
		return legacyNativeCommandGuidance(
			args,
			this.list().map(([name]) => name),
		);
	}
	/** `/octocode <args>` is the retired namespaced form unless its first word is one the `/octocode` command offers itself. */
	private retiredForm(command: Subcommand, args: string): boolean {
		const word = args.trim().split(/\s+/, 1)[0] ?? "";
		if (!word) return false;
		return !(command.complete?.("") ?? []).some((item) => item.value === word);
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
