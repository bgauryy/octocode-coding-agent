import type { AutocompleteItem } from "@octocodeai/octocode-tui";
import type { FeatureSetup, CommandContext, FeatureContext, SessionUI } from "../../core/features/index.ts";
import { withDialog } from "./locks.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";

type NoticeLevel = "info" | "warning" | "error";

/**
 * Shows a notification. Octocode draws notify text as is, and notices carry file names, error messages, hook commands and
 * server text, so every notice goes through `sanitizeTerminalText` here. The one exception is the machine-read audit
 * relay (`childAuditMessage`) and its exposure report (`exposureMessage`), which a parent parses and never draws.
 */
export function notify(ui: Pick<SessionUI, "notify">, text: string, level: NoticeLevel = "info"): void {
	ui.notify(sanitizeTerminalText(text), level);
}

/**
 * Shows a command's output. With a UI (TUI, and RPC, which forwards notifications) it is a notification. Print and
 * JSON modes have no UI (`notify` does nothing there) and Octocode reserves stdout for the final answer or the JSONL event
 * stream, so the text goes to stderr: visible in a terminal, and never mixed into `-p` output or `--mode json` records.
 */
export function say(ctx: Pick<FeatureContext, "hasUI" | "ui">, text: string, level: NoticeLevel = "info"): void {
	notify(ctx.ui, text, level);
	if (!ctx.hasUI) process.stderr.write(`${sanitizeTerminalText(text)}\n`);
}

/**
 * A command that did not do what it was asked: a warning with a UI; without one (print and JSON modes) an error the
 * command runner reports, so the run exits non-zero instead of printing the refusal and succeeding.
 */
export function refuse(ctx: Pick<FeatureContext, "hasUI" | "ui">, text: string): void {
	if (!ctx.hasUI) throw new Error(text);
	say(ctx, text, "warning");
}

const CANCELLED = "Cancelled: nothing was ";

/** The one line a declined or abandoned confirmation says: `cancelledText("stopped")` is "Cancelled: nothing was stopped.". */
export function cancelledText(verb: string): string {
	return `${CANCELLED}${verb}.`;
}

/** Whether a notice is `cancelledText`'s line: the command stopped at the user's word and did nothing. */
export const isCancelledText = (text: string): boolean => text.startsWith(CANCELLED);

/** A native command registered once under its canonical name. */
export interface Subcommand {
	/** One sentence of at most 50 characters; usage goes in `argumentHint`. */
	description: string;
	/** Usage after the command name, such as `[all|<query>]`. */
	argumentHint?: string;
	/** The only first words accepted (see `RegisteredCommand.argumentWords`); omit when free text is valid. */
	argumentWords?: readonly string[];
	dialog?: "handler" | "interaction";
	handler(args: string, ctx: CommandContext): Promise<void>;
	complete?(prefix: string): AutocompleteItem[] | null;
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
	register(api: FeatureSetup): void {
		for (const [name, command] of this.list()) {
			api.commands.register(name, {
				description: command.description,
				...(command.argumentHint && { argumentHint: command.argumentHint }),
				...(command.argumentWords && { argumentWords: command.argumentWords }),
				getArgumentCompletions: (prefix) => command.complete?.(prefix.trimStart()) ?? null,
				handler: async (args, ctx) =>
					command.dialog === "interaction"
						? command.handler(args.trim(), ctx)
						: withDialog(() => command.handler(args.trim(), ctx)),
			});
		}
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
