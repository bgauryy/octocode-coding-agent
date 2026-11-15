import path from "node:path";
import { GLYPH, SEPARATOR, SPINNER } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { APP_TITLE } from "../../config.ts";
import { ENTITY } from "../shared/entity.ts";

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

/** Background subagents in the tab: the subagent mark, with their number when more than one runs. */
const AGENTS_MARK = ENTITY.subagent;

/**
 * `✻ 🐙2 Octocode · fix login · repo`: the state mark, the background subagents still running, then the app, session
 * name and working directory.
 */
export function terminalTitle(state: TitleState, sessionName: string | undefined, cwd: string, agents = 0): string {
	const name = sessionName ? sanitizeTerminalText(sessionName).trim() : "";
	const base = [APP_TITLE, name, path.basename(cwd)].filter(Boolean).join(SEPARATOR);
	const agentsMark = agents > 0 ? `${AGENTS_MARK}${agents > 1 ? agents : ""}` : "";
	return [TITLE_MARK[state], agentsMark, base].filter(Boolean).join(" ");
}

/**
 * Folds run events into a title state. During a run: `waiting` while a dialog is open, `running` while a tool
 * executes, else `thinking`. After it: `running` while background work (subagents, jobs) still runs, then the outcome
 * (`done`, `failed`, or `idle` when interrupted) until `seen`.
 */
export class TitleTracker {
	private active = false;
	private background = 0;
	private readonly tools = new Set<string>();
	/** Open dialogs by id, each with whether it blocks: the agent (or a background subagent) waits on the user. */
	private readonly prompts = new Map<string | undefined, boolean>();
	private outcome: "idle" | "done" | "failed" = "idle";

	get state(): TitleState {
		if (!this.active) {
			if ([...this.prompts.values()].some(Boolean)) return "waiting";
			return this.background > 0 ? "running" : this.outcome;
		}
		if (this.prompts.size > 0) return "waiting";
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

	/**
	 * Dialog `id` opened. `blocking`: it waits for the user to go on, so it shows `waiting` even when no run is active.
	 * Returns whether it is the first blocking dialog open, in whatever order dialogs open and close.
	 */
	promptStart(id: string | undefined, blocking = false): boolean {
		const first = blocking && ![...this.prompts.values()].some(Boolean);
		this.prompts.set(id, blocking);
		return first;
	}

	promptEnd(id: string | undefined): void {
		this.prompts.delete(id);
	}

	settle(outcome: "idle" | "done" | "failed"): void {
		this.active = false;
		this.tools.clear();
		this.outcome = outcome;
	}

	/** How many background subagents and jobs run now; the outcome waits until none does. */
	setBackground(count: number): void {
		this.background = count;
	}

	/** The user is back: a finished outcome has been seen. A run or background work in progress keeps its state. */
	seen(): void {
		if (this.background === 0) this.outcome = "idle";
	}

	reset(): void {
		this.settle("idle");
		this.prompts.clear();
	}
}
