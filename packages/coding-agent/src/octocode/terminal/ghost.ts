import {
	type HistoryEntry,
	type NextCommandRequest,
	type NextCommandSuggester,
	suggestCommand,
} from "../../../../terminal/src/index.ts";

/** Pause in typing before a model is asked. */
const MODEL_DELAY_MS = 400;

export interface GhostSources {
	setSuggestion(text: string | undefined): void;
	cwd(): string;
	history(): readonly HistoryEntry[];
	/** Commands from the agent's last reply. */
	reply(): readonly string[];
	historyEnabled(): boolean;
	/** Whether a model may be asked now (the setting, and a session to ask through). */
	modelEnabled(): boolean;
	suggester: NextCommandSuggester;
	request(prefix: string): NextCommandRequest;
	delayMs?: number;
}

/**
 * Ghost text for `!` lines. Each change of the editor's text looks for a command that extends what follows `!`: one from
 * the agent's last reply, then the history. With none, and after a pause, the small model is asked once for that prefix
 * (an empty prefix asks for the likely next command). A suggestion the user is typing along stays until it no longer fits.
 */
export class GhostController {
	private readonly sources: GhostSources;
	private text = "";
	private current: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private asking: AbortController | undefined;

	constructor(sources: GhostSources) {
		this.sources = sources;
	}

	private show(text: string | undefined): void {
		this.current = text;
		this.sources.setSuggestion(text);
	}

	private cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.asking?.abort();
		this.asking = undefined;
	}

	update(text: string): void {
		this.cancel();
		this.text = text;
		const bang = /^\s*!!?\s*/.exec(text)?.[0];
		if (bang === undefined || text.includes("\n") || !this.sources.historyEnabled()) return this.show(undefined);
		const typed = text.slice(bang.length);
		const found = suggestCommand(typed, {
			cwd: this.sources.cwd(),
			history: this.sources.history(),
			reply: this.sources.reply(),
		});
		if (found) return this.show(bang + found);
		if (this.current && this.current.length > text.length && this.current.startsWith(text)) return;
		if (!this.sources.modelEnabled()) return this.show(undefined);
		const cached = this.sources.suggester.cached(this.sources.cwd(), typed);
		if (cached !== undefined) return this.show(cached ? bang + cached : undefined);
		this.show(undefined);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const controller = new AbortController();
			this.asking = controller;
			void this.sources.suggester.suggest(this.sources.request(typed), controller.signal).then((command) => {
				if (controller.signal.aborted || this.text !== text) return;
				this.asking = undefined;
				if (command) this.show(bang + command);
			});
		}, this.sources.delayMs ?? MODEL_DELAY_MS);
		this.timer.unref?.();
	}

	/** Forgets the shown suggestion (a command ran, the session changed). */
	reset(): void {
		this.cancel();
		this.show(undefined);
	}

	dispose(): void {
		this.reset();
	}
}
