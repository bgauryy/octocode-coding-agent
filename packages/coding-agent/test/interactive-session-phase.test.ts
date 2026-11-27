import type { ApplicationPhase } from "@octocodeai/octocode-contracts";
import type { ProgramStatus, Terminal } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import { bindSessionPhase } from "../src/modes/interactive/interactive-mode/session-phase.ts";
import { SessionStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
import { sessionActivity } from "../src/octocode/activity/session-activity.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

/** A host over a real application port: OSC 9;4 is `setProgress`, OSC 7501 is `setProgramStatus`. */
function setup() {
	const progress: boolean[] = [];
	const statuses: ProgramStatus[] = [];
	const terminal = {
		setProgress: (on: boolean) => progress.push(on),
		setProgramStatus: (status: ProgramStatus) => statuses.push(status),
	} as unknown as Terminal;
	const session = {
		sessionId: "phase-session",
		messages: [],
		isStreaming: false,
		isCompacting: false,
		subscribe: () => () => {},
	} as unknown as AgentSession;
	const port = getApplicationPort(session);
	const host = createFakeHost({
		session,
		settingsManager: { getShowTerminalProgress: () => true },
		ui: { requestRender: vi.fn(), terminal },
		programStatus: new SessionStatusReporter(
			() => terminal,
			() => "job",
			() => true,
		),
		clearStatusIndicator: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		showError: vi.fn(),
		showWarning: vi.fn(),
	});
	const stop = bindSessionPhase(host, port.stateSource);
	const publish = (phase: ApplicationPhase) => port.publishDomain({ type: "session.phase", phase });
	/**
	 * The run starts and settles after the extension published the phase it derived. Contract change (RFC app-state, T2):
	 * the program status and the tab progress read only the application state, so the run's events reach just the
	 * run-state handler (which no longer touches the progress).
	 */
	const start = async () => {
		(session as { isStreaming: boolean }).isStreaming = true;
		publish({ state: "working" });
	};
	const settle = async (phase: ApplicationPhase) => {
		publish(phase);
		(session as { isStreaming: boolean }).isStreaming = false;
		const event: AgentSessionEvent = { type: "agent_settled", aborted: false };
		await handleRunStateEvent(host, event);
	};
	const state = () => statuses.at(-1)?.state;
	return {
		host,
		port,
		progress,
		statuses,
		publish,
		start,
		settle,
		state,
		stop,
		clear: vi.mocked(host.clearStatusIndicator),
	};
}

const waiting: ApplicationPhase = { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 };
/** The last program status without its app name. */
const statusOf = (t: ReturnType<typeof setup>) => {
	const { app: _app, ...status } = t.statuses.at(-1) ?? { state: "clear" };
	return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
};

describe("host reads the session phase", () => {
	it("keeps OSC 9;4 and OSC 7501 working after agent_settled while a background child runs, and ends both when the phase is done", async () => {
		const t = setup();
		await t.start();
		expect(t.state()).toBe("working");
		await t.settle(waiting);
		// The run settled but the job did not: no progress-off, program status still working.
		expect(t.progress).toEqual([true]);
		expect(t.state()).toBe("working");
		expect(t.clear).toHaveBeenCalledWith("working");
		// The child reports and a wake resumes the session, then its report run settles with nothing left.
		t.publish({ state: "resuming", label: "report from child" });
		expect(t.progress.at(-1)).toBe(true);
		expect(t.state()).toBe("working");
		await t.start();
		await t.settle({ state: "done" });
		expect(t.progress.at(-1)).toBe(false);
		expect(t.state()).toBe("done");
		t.stop();
	});

	it("turns final when the child drains without a wake, and reports an error only for the failed phase", async () => {
		const t = setup();
		await t.start();
		await t.settle(waiting);
		t.publish({ state: "done" });
		expect(t.progress.at(-1)).toBe(false);
		expect(t.state()).toBe("done");
		t.stop();
	});

	it("follows the light for a timer alone (idle, no progress) and for a stopped phase (error)", async () => {
		// Contract change (status dots, wave C, decision Q1): the tab follows the session's activity light. A pending timer
		// runs nothing, so the tab is idle; a job that stopped with items open is an error, as the light is red.
		const t = setup();
		await t.start();
		await t.settle({ state: "scheduled", timers: 1, id: "t1", dueAt: 10 });
		expect(t.progress.at(-1)).toBe(false);
		expect(t.state()).toBe("idle");
		t.publish({ state: "stopped", open: ["B1"] });
		expect(t.progress.at(-1)).toBe(false);
		expect(statusOf(t)).toEqual({ state: "error", message: "Stopped: B1 still open" });
		t.stop();
	});

	it("reports on the tab what the activity light shows: idle, working, needs you, failed and done", async () => {
		const t = setup();
		const agree = (expected: ProgramStatus["state"]) => {
			const light = sessionActivity(t.port.stateSource);
			const shown = {
				working: "working",
				waiting: "blocked",
				error: "error",
				idle: light.label === "done" ? "done" : "idle",
			};
			expect(shown[light.tone], light.label).toBe(expected);
			expect(t.state(), light.label).toBe(expected);
		};
		agree("idle");
		await t.start();
		agree("working");
		t.port.publishDomain({ type: "session.awaiting", awaiting: { kind: "approval", title: "Run bash?" } });
		agree("blocked");
		expect(statusOf(t)).toEqual({ state: "blocked", kind: "permission", message: "Run bash?" });
		t.port.publishDomain({ type: "session.awaiting" });
		agree("working");
		await t.settle({ state: "failed", error: "Invalid API key\n{details}" });
		agree("error");
		expect(statusOf(t)).toEqual({ state: "error", message: "Invalid API key" });
		await t.start();
		await t.settle({ state: "done" });
		agree("done");
		await t.start();
		await t.settle({ state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 });
		agree("working");
		t.stop();
	});

	it("does not clear the progress of a run that is streaming when the phase changes", async () => {
		const t = setup();
		await t.start();
		await t.settle(waiting);
		await t.start();
		const before = t.progress.length;
		t.publish({ state: "working" });
		expect(t.progress.length).toBe(before);
		t.stop();
	});
});
