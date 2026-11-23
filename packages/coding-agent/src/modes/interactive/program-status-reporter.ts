import { activity, type ActivityFacts } from "@octocodeai/octocode-projections";
import type { ProgramStatus, Terminal } from "@octocodeai/octocode-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";

export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/**
 * Reports interactive-mode state to the terminal (OSC 7501), with the tab progress (OSC 9;4) on while it is `working`:
 * the session's activity light (`activity`, which the footer and the web read too) from the facts of its application
 * state (`setPhase`). `working` for a run, compaction, a retry, background work or a wake; `blocked` while a dialog
 * waits; `error` for a failed or stopped job; `done` after a job that ended well and `idle` otherwise, a pending timer
 * included. A host dialog (`setBlocked`: a login, a feature selector) reports `blocked` over it. Before the facts are
 * bound nothing runs: `idle`. Messages are limited to the session name, dialog titles, and the first line of errors;
 * prompts and assistant output are never reported.
 */
export class SessionStatusReporter {
	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;
	/** Open dialogs by source, in the order they opened. The most recent one is reported. */
	private readonly blocked = new Map<string, BlockedStatus>();
	/** The session's application state facts its light reads; undefined until a port is bound. */
	private facts: ActivityFacts | undefined;
	private lastReport: string | undefined;
	/** Whether the tab progress is on: the terminal starts without it. */
	private progress = false;
	private readonly showProgress: () => boolean;

	/** `showProgress`: whether the tab progress (OSC 9;4) is wanted (`terminal.showTerminalProgress`), read when it changes. */
	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined, showProgress = () => false) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
		this.showProgress = showProgress;
	}

	/** The session name is part of working and done reports: a rename reports again. Every other event is the facts'. */
	handleEvent(event: AgentSessionEvent): void {
		if (event.type === "session_info_changed") this.report();
	}

	/** Report `blocked` for a dialog until it is cleared with `undefined`. Reopening a source replaces it. */
	setBlocked(source: string, status: BlockedStatus | undefined): void {
		this.blocked.delete(source);
		if (status) this.blocked.set(source, status);
		this.report();
	}

	/** The facts of the session's application state (its phase, dialog, status and run); undefined forgets them. */
	setPhase(facts: ActivityFacts | undefined): void {
		this.facts = facts;
		this.report();
	}

	/** Forget the previous session's facts, for example after switching sessions. */
	reset(): void {
		this.facts = undefined;
		this.report();
	}

	/** Sends the status when it changed, and turns the tab progress on or off as the status becomes or stops being working. */
	report(): void {
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		const working = status.state === "working";
		if (working !== this.progress) {
			this.progress = working;
			if (this.showProgress()) this.getTerminal().setProgress(working);
		}
		const key = JSON.stringify(status);
		if (key === this.lastReport) return;
		this.lastReport = key;
		this.getTerminal().setProgramStatus(status);
	}

	private currentStatus(): ProgramStatus {
		const blocked = [...this.blocked.values()].at(-1);
		if (blocked) return { state: "blocked", ...blocked };
		return this.facts ? this.lit(this.facts) : { state: "idle" };
	}

	/** The program status of the session's light, with the details its facts carry. */
	private lit(facts: ActivityFacts): ProgramStatus {
		const light = activity(facts);
		const { awaiting, phase } = facts;
		switch (light.tone) {
			case "waiting": {
				const title =
					typeof awaiting === "object" ? awaiting.title : phase?.state === "blocked" ? phase.title : undefined;
				const kind = typeof awaiting === "object" && awaiting.kind === "approval" ? "permission" : "question";
				return { state: "blocked", kind, ...(title ? { message: title } : {}) };
			}
			case "working":
				return {
					state: "working",
					message: light.label === "compacting" ? "Compacting context" : this.getSessionName(),
				};
			case "error": {
				if (phase?.state === "failed") return { state: "error", message: firstLine(phase.error) };
				const open = phase?.state === "stopped" ? phase.open.slice(0, 5) : [];
				return { state: "error", message: open.length ? `Stopped: ${open.join(", ")} still open` : "Stopped" };
			}
			case "idle":
				return light.label === "done" ? { state: "done", message: this.getSessionName() } : { state: "idle" };
		}
	}
}
