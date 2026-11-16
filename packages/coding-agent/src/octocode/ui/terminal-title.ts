import path from "node:path";
import { SEPARATOR, SPINNER, TITLE_FRAME_MS, type TitleState } from "@octocodeai/octocode-tui";
import { cleanTitle } from "../../core/session-manager/title.ts";
import { ENTITY } from "../shared/entity.ts";

export { TITLE_FRAME_MS, type TitleState };

/** Busy frames: the footer's braille loader. Every frame is one cell wide, so the tab label never shifts while it animates. */
const BUSY_FRAMES = SPINNER.braille;

/** Each state's mark after the octopus (busy states animate through several; idle has none) and the word the tab shows. */
export const TITLE_STATE: Readonly<Record<TitleState, { frames: readonly string[]; label: string }>> = {
	idle: { frames: [""], label: "Idle" },
	thinking: { frames: BUSY_FRAMES, label: "Thinking" },
	running: { frames: BUSY_FRAMES, label: "Running" },
	waiting: { frames: ["⚠️"], label: "Needs you" },
	done: { frames: ["🟢"], label: "Done" },
	failed: { frames: ["🔴"], label: "Error" },
};

/** Most characters of the description a tab shows. */
const DESCRIPTION_MAX = 40;

/** `fix login · repo`: the description (escape sequences dropped, one line, capped), then the working directory. */
export function plainTitle(description: string | undefined, cwd: string): string {
	const name = description ? cleanTitle(description, DESCRIPTION_MAX) : "";
	return [name, path.basename(cwd)].filter(Boolean).join(SEPARATOR);
}

/**
 * `🐙⠋ Running - fix login · repo · 2 agents`: the octopus with the state's mark (frame `frame` of a busy state) and word,
 * the plain title, then how many background subagents still run.
 */
export function terminalTitle(
	state: TitleState,
	description: string | undefined,
	cwd: string,
	agents = 0,
	frame = 0,
): string {
	const { frames, label } = TITLE_STATE[state];
	const agentsMark = agents > 0 ? `${SEPARATOR}${agents} agent${agents > 1 ? "s" : ""}` : "";
	const subject = plainTitle(description, cwd);
	return `${ENTITY.subagent}${frames[frame % frames.length]} ${label}${subject ? ` - ${subject}` : ""}${agentsMark}`;
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
