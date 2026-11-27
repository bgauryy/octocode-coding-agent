import type { ApplicationAwaiting, ApplicationPhase } from "@octocodeai/octocode-contracts";
import { activity, type ActivityTone } from "@octocodeai/octocode-projections";
import type { ProgramStatus, Terminal } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ApplicationRuntimeState, ApplicationStateSource } from "../src/core/application/state.ts";
import { bindSessionPhase } from "../src/modes/interactive/interactive-mode/session-phase.ts";
import { SessionStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

/**
 * RFC 2026-11-23-app-state, T2 (V3): the terminal's program status (OSC 7501) and tab progress (OSC 9;4) read the one
 * activity light the footer and the web read. For every phase, status, dialog and run, the program status names the
 * light's tone and the tab shows progress exactly while the light is working.
 */

const PHASES: ApplicationPhase[] = [
	{ state: "blocked", title: "Allow bash?" },
	{ state: "working", activity: "Reading files" },
	{ state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 },
	{ state: "resuming", label: "report from child" },
	{ state: "scheduled", timers: 1, id: "t1", dueAt: 10 },
	{ state: "stopped", open: ["B1"] },
	{ state: "failed", error: "Invalid API key\n{details}" },
	{ state: "done" },
	{ state: "idle" },
];
const STATUSES = ["idle", "compacting", "retrying", "stalled"] as const;
const DIALOGS: Array<ApplicationAwaiting | undefined> = [undefined, { kind: "approval", title: "Run rm?" }];

/** The tone a program status shows: blocked waits on the user, done and idle rest. */
const TONE: Record<ProgramStatus["state"], ActivityTone> = {
	working: "working",
	blocked: "waiting",
	error: "error",
	done: "idle",
	idle: "idle",
	clear: "idle",
};

describe("the terminal tab follows the activity light", () => {
	it("gives the program status and the tab progress the light's tone in every combination", () => {
		const statuses: ProgramStatus[] = [];
		const progress: boolean[] = [];
		const terminal = {
			setProgress: (on: boolean) => progress.push(on),
			setProgramStatus: (status: ProgramStatus) => statuses.push(status),
		} as unknown as Terminal;
		const store = createStore<Pick<ApplicationRuntimeState, "phase" | "awaiting" | "status" | "streaming">>()(() => ({
			status: "idle",
			streaming: false,
		}));
		const host = createFakeHost({
			programStatus: new SessionStatusReporter(
				() => terminal,
				() => "job",
				() => true,
			),
		});
		const stop = bindSessionPhase(host, store as unknown as ApplicationStateSource);
		let cases = 0;
		for (const phase of PHASES)
			for (const status of STATUSES)
				for (const awaiting of DIALOGS)
					for (const streaming of [false, true]) {
						store.setState({ phase, status, awaiting, streaming });
						const light = activity({ phase, status, awaiting, streaming });
						const shown = `${phase.state}/${status}/${awaiting ? "dialog" : "none"}/${streaming ? "run" : "rest"}`;
						expect(TONE[statuses.at(-1)!.state], shown).toBe(light.tone);
						expect(progress.at(-1) ?? false, shown).toBe(light.tone === "working");
						cases++;
					}
		expect(cases).toBe(9 * 4 * 2 * 2);
		stop();
	});
});
