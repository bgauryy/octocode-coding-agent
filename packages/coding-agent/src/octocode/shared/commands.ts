import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "../../core/features/index.ts";
import { withDialog } from "./locks.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";

type NoticeLevel = "info" | "warning" | "error";

/**
 * Shows a notification. Octocode draws notify text as is, and notices carry file names, error messages, hook commands and
 * server text, so every notice goes through `sanitizeTerminalText` here. The one exception is the machine-read audit
 * relay (`childAuditMessage`) and its exposure report (`exposureMessage`), which a parent parses and never draws.
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

/**
 * Retired command names, with the command line that replaced each; their arguments carry over. `/plugins` and `/hooks`
 * folded into `/harness`; `/login` became `/providers` (sign-in is its "+ Add a provider" row); `/config` and `/settings`
 * became `/configuration`, the one place to enable, disable, set and add configuration.
 */
const RETIRED_COMMANDS: Record<string, string> = {
	plugins: "harness",
	hooks: "harness hooks",
	config: "configuration",
	settings: "configuration",
	login: "providers",
};

/**
 * For input under a retired name, the line that replaced it, while the replacing command is registered and nothing
 * else (a prompt or skill) took the old name; undefined otherwise.
 */
function foldedReplacement(text: string, commands: readonly string[]): string | undefined {
	const match = /^\/([a-z]+)(?:\s+(.*))?$/s.exec(text.trim());
	const to = match && Object.hasOwn(RETIRED_COMMANDS, match[1]) ? RETIRED_COMMANDS[match[1]] : undefined;
	if (!to || !commands.includes(to.split(" ")[0]) || commands.includes(match![1])) return undefined;
	const rest = match![2]?.trim();
	return rest ? `${to} ${rest}` : to;
}

/**
 * For input in a retired form, the registered command line that replaced it (`harness`, `harness hooks events`);
 * undefined when `text` is not a retired form or nothing registered replaces it.
 */
export function retiredCommandReplacement(text: string, commands: readonly string[]): string | undefined {
	return foldedReplacement(text, commands);
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
				handler: async (args, ctx) =>
					command.dialog === "interaction"
						? command.handler(args.trim(), ctx)
						: withDialog(() => command.handler(args.trim(), ctx)),
			});
		}
		// No command has a retired name, so SDK and RPC input reaches this hook; the terminal reports it as unknown first.
		api.on("input", async (event, ctx) => {
			if (this.has("harness") && /^\/(?:plugins|hooks)(?:\s|$)/.test(event.text.trim())) {
				const to = foldedReplacement(
					event.text,
					api.getCommands().map((command) => command.name),
				);
				if (!to) return { action: "continue" };
				const from = event.text.trim().split(/\s+/, 1)[0].slice(1);
				say(ctx, `/${from} moved to /${RETIRED_COMMANDS[from]}. Run /${to} to continue.`, "warning");
				return { action: "handled" };
			}
			return { action: "continue" };
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
