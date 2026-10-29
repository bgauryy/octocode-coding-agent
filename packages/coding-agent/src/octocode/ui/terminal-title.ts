import path from "node:path";
import { GLYPH, SEPARATOR, SPINNER } from "@octocodeai/octocode-tui";
import { APP_TITLE } from "../../config.ts";
import { sanitizeTerminalText } from "../shared/sanitize.ts";

/** What the session is doing, as the terminal tab shows it. */
export type TitleState = "idle" | "thinking" | "running" | "waiting" | "done" | "failed";

/** One single-width mark per state, taken from the TUI's design tokens; idle has none. */
export const TITLE_MARK: Readonly<Record<TitleState, string>> = {
	idle: "",
	thinking: GLYPH.turn,
	running: SPINNER.quadrant[0],
	waiting: GLYPH.waiting,
	done: GLYPH.done,
	failed: GLYPH.failed,
};

/** `✻ Octocode · fix login · repo`: the state mark, then the app, session name and working directory. */
export function terminalTitle(state: TitleState, sessionName: string | undefined, cwd: string): string {
	const name = sessionName ? sanitizeTerminalText(sessionName).trim() : "";
	const base = [APP_TITLE, name, path.basename(cwd)].filter(Boolean).join(SEPARATOR);
	const mark = TITLE_MARK[state];
	return mark ? `${mark} ${base}` : base;
}

/**
 * Folds run events into a title state. During a run: `waiting` while a dialog is open, `running` while a tool
 * executes, else `thinking`. After it: the outcome (`done`, `failed`, or `idle` when interrupted) until `seen`.
 */
export class TitleTracker {
	private active = false;
	private readonly tools = new Set<string>();
	private prompts = 0;
	private outcome: "idle" | "done" | "failed" = "idle";

	get state(): TitleState {
		if (!this.active) return this.outcome;
		if (this.prompts > 0) return "waiting";
		return this.tools.size > 0 ? "running" : "thinking";
	}

	start(): void {
		this.active = true;
		this.tools.clear();
		this.outcome = "idle";
	}

	toolStart(id: string): void {
		if (this.active) this.tools.add(id);
	}

	toolEnd(id: string): void {
		this.tools.delete(id);
	}

	promptStart(): void {
		this.prompts += 1;
	}

	promptEnd(): void {
		this.prompts = Math.max(0, this.prompts - 1);
	}

	settle(outcome: "idle" | "done" | "failed"): void {
		this.active = false;
		this.tools.clear();
		this.outcome = outcome;
	}

	/** The user is back: a finished outcome has been seen. A run in progress keeps its state. */
	seen(): void {
		this.outcome = "idle";
	}

	reset(): void {
		this.settle("idle");
		this.prompts = 0;
	}
}
