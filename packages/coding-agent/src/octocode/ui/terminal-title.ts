import path from "node:path";
import { SEPARATOR, SPINNER, TITLE_FRAME_MS, type TitleState, titleMark } from "@octocodeai/octocode-tui";
import { activity, type Activity } from "@octocodeai/octocode-projections";
import { cleanTitle } from "../../core/session-manager/title.ts";

export { TITLE_FRAME_MS, type TitleState };

/** Busy frames: the footer's braille loader. Every frame is one cell wide, so the tab label never shifts while it animates. */
const BUSY_FRAMES = SPINNER.braille;

/** Each state's mark after the mark (busy states animate through several; idle has none) and the word the tab shows. */
export const TITLE_STATE: Readonly<Record<TitleState, { frames: readonly string[]; label: string }>> = {
	idle: { frames: [""], label: "Idle" },
	thinking: { frames: BUSY_FRAMES, label: "Thinking" },
	running: { frames: BUSY_FRAMES, label: "Running" },
	// The team panel's word for an agent whose own turn is over while its children or jobs work.
	background: { frames: ["⏳"], label: "Waiting" },
	waiting: { frames: ["⚠️"], label: "Needs you" },
	done: { frames: ["🟢"], label: "Done" },
	failed: { frames: ["🔴"], label: "Error" },
};

/** Most characters of the description a tab shows. */
const DESCRIPTION_MAX = 40;
/** Most characters of the agent's name a tab shows. */
const NAME_MAX = 32;

/** `fix login · repo`: the description (escape sequences dropped, one line, capped), then the working directory. */
export function plainTitle(description: string | undefined, cwd: string): string {
	const name = description ? cleanTitle(description, DESCRIPTION_MAX) : "";
	return [name, path.basename(cwd)].filter(Boolean).join(SEPARATOR);
}

/**
 * `◈⠋ shy-barnacle Running - fix login · repo · 2 agents`: the main session's mark (a glyph; the squid with emoji marks on) with the state's mark (frame
 * `frame` of a busy state), the agent's team name once it joined, the state's word, the plain title, then how many
 * background subagents still run.
 */
export function terminalTitle(
	state: TitleState,
	description: string | undefined,
	cwd: string,
	agents = 0,
	frame = 0,
	name?: string,
): string {
	const { frames, label } = TITLE_STATE[state];
	const agentsMark = agents > 0 ? `${SEPARATOR}${agents} agent${agents > 1 ? "s" : ""}` : "";
	const subject = plainTitle(description, cwd);
	const who = name ? cleanTitle(name, NAME_MAX) : "";
	return `${titleMark()}${frames[frame % frames.length]} ${who ? `${who} ` : ""}${label}${subject ? ` - ${subject}` : ""}${agentsMark}`;
}

/**
 * The tab's state: the session's activity light (`activity`, the footer's and the program status's), refined while its
 * own run goes on. During a run: `waiting` while a dialog is open, `running` while a tool executes, else `thinking`. With
 * no run of its own the light decides: `background` while it is working (background agents, a wake, compaction or a
 * retry), `waiting` while it needs you, `failed` for a failed or stopped job and `done` for one that ended well, both
 * until `seen`, else `idle` (a pending timer included).
 */
export class TitleTracker {
	private active = false;
	private light: Activity = activity(undefined);
	/** The finished light the user has seen: `done` or `failed` shows until then. */
	private seenLight: Activity | undefined;
	private readonly tools = new Set<string>();
	/** Open dialogs by id, each with whether it blocks: the agent (or a background subagent) waits on the user. */
	private readonly prompts = new Map<string | undefined, boolean>();

	get state(): TitleState {
		if ([...this.prompts.values()].some(Boolean) || this.light.tone === "waiting") return "waiting";
		// The light's `working` word is the session's own run, whichever of its run's events or its phase came first.
		if (this.active || (this.light.tone === "working" && this.light.label === "working")) {
			if (this.prompts.size > 0) return "waiting";
			return this.tools.size > 0 ? "running" : "thinking";
		}
		if (this.light.tone === "working") return "background";
		const finished = this.light.tone === "error" ? "failed" : this.light.label === "done" ? "done" : undefined;
		return finished && this.seenLight !== this.light ? finished : "idle";
	}

	/** The session's light changed. */
	setLight(next: Activity): void {
		this.light = next;
	}

	start(): void {
		this.active = true;
		this.tools.clear();
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

	/** The session's own run ended; the light says what became of the job. */
	settle(): void {
		this.active = false;
		this.tools.clear();
	}

	/** The user is back: the finished light now is seen. A run or outstanding work keeps its state. */
	seen(): void {
		this.seenLight = this.light;
	}

	reset(): void {
		this.settle();
		this.prompts.clear();
		this.light = activity(undefined);
		this.seenLight = undefined;
	}
}
