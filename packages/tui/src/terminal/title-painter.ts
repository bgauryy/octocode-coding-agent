import { stdoutAcceptsDecoration } from "./stall-watch.ts";

/** What the session is doing, as the terminal tab shows it; `background`: its run ended, its children, jobs or wakes still run. */
export type TitleState = "idle" | "thinking" | "running" | "background" | "waiting" | "done" | "failed";

/** How often a busy title moves to its next frame: slow, so a terminal that reads slowly never falls behind on titles. */
export const TITLE_FRAME_MS = 1000;

/** Whether a state animates. */
export const isBusyTitle = (state: TitleState | undefined) => state === "thinking" || state === "running";

/** The title text the app owns: the painter decides when to write, the app what the tab says. */
export interface TitleFormat {
	/** The title for a state, `frame` counting animation steps of a busy state. */
	full(state: TitleState, description: string | undefined, cwd: string, agents: number, frame: number): string;
	/** The title without a state. */
	plain(description: string | undefined, cwd: string): string;
}

/** Thinking and tool runs alternate within milliseconds; their title swaps are coalesced over this window. */
const TITLE_COALESCE_MS = 250;

/** What the title is painted from. */
export interface TitleSource {
	state(): TitleState;
	/** The tab to paint; undefined without a terminal UI. */
	target(): { cwd: string; setTitle(text: string): void } | undefined;
	/** The session name, else its first prompt. */
	description(): string | undefined;
	/** Background subagents still running. */
	agents(): number;
}

/**
 * Writes the terminal title only when its text changes. A busy title animates one frame per `TITLE_FRAME_MS` and stops
 * when the session settles; busy-to-busy swaps are coalesced. While the terminal is not reading, titles wait and only
 * the latest is written once it reads again (a forced repaint is written at once). Timers never keep the process alive.
 */
export class TitlePainter {
	private readonly source: TitleSource;
	private shown: { state: TitleState; text: string } | undefined;
	private coalesce: ReturnType<typeof setTimeout> | undefined;
	private animation: ReturnType<typeof setInterval> | undefined;
	private frame = 0;

	private readonly format: TitleFormat;
	private readonly acceptsOutput: () => boolean;

	/** @param acceptsOutput Whether a title may be written now; by default, whether stdout is not backed up. */
	constructor(source: TitleSource, format: TitleFormat, acceptsOutput: () => boolean = stdoutAcceptsDecoration) {
		this.source = source;
		this.format = format;
		this.acceptsOutput = acceptsOutput;
	}

	/** Repaint; `force` rewrites the title after another writer (the host, a session switch) may have replaced it. */
	paint(force = false): void {
		if (!force && isBusyTitle(this.source.state()) && isBusyTitle(this.shown?.state)) {
			if (!this.coalesce) {
				this.coalesce = setTimeout(() => this.write(false), TITLE_COALESCE_MS);
				this.coalesce.unref?.();
			}
			return;
		}
		this.write(force);
	}

	/** Stop animating and forget what was shown, as when a session starts or ends. */
	reset(): void {
		this.stopTimers();
		this.shown = undefined;
	}

	/** Stop animating; the title stays as last written. */
	stop(): void {
		this.stopTimers();
	}

	/** The session leaves the tab: stop animating and write the plain title, without a state. */
	leave(): void {
		const target = this.source.target();
		this.reset();
		target?.setTitle(this.format.plain(this.source.description(), target.cwd));
	}

	private write(force: boolean): void {
		if (this.coalesce) clearTimeout(this.coalesce);
		this.coalesce = undefined;
		const target = this.source.target();
		const state = target ? this.source.state() : undefined;
		this.animate(state);
		if (!target || !state) return;
		const agents = state === "idle" ? 0 : this.source.agents();
		const text = this.format.full(state, this.source.description(), target.cwd, agents, this.frame);
		if (!force && this.shown?.text === text) return;
		if (!force && !this.acceptsOutput()) {
			// A busy title retries on its next frame; any other waits for this retry.
			if (!this.animation) {
				this.coalesce = setTimeout(() => this.write(false), TITLE_FRAME_MS);
				this.coalesce.unref?.();
			}
			return;
		}
		this.shown = { state, text };
		target.setTitle(text);
	}

	private animate(state: TitleState | undefined): void {
		if (!isBusyTitle(state)) {
			this.stopTimers();
			return;
		}
		if (this.animation) return;
		this.animation = setInterval(() => {
			this.frame += 1;
			this.write(false);
		}, TITLE_FRAME_MS);
		this.animation.unref?.();
	}

	private stopTimers(): void {
		if (this.animation) clearInterval(this.animation);
		this.animation = undefined;
		this.frame = 0;
		if (this.coalesce) clearTimeout(this.coalesce);
		this.coalesce = undefined;
	}
}
