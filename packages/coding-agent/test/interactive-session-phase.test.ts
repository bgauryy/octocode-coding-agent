import type { ApplicationPhase } from "@octocodeai/octocode-contracts";
import type { ProgramStatus, Terminal } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { handleRunStateEvent } from "../src/modes/interactive/interactive-mode/run-state-events.ts";
import { bindSessionPhase } from "../src/modes/interactive/interactive-mode/session-phase.ts";
import { SessionStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
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
		),
		clearStatusIndicator: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		showError: vi.fn(),
		showWarning: vi.fn(),
	});
	const stop = bindSessionPhase(host, port.stateSource);
	const publish = (phase: ApplicationPhase) => port.publishDomain({ type: "session.phase", phase });
	/** The host's own events: the run starts and settles after the extension published the phase it derived. */
	const start = async () => {
		(session as { isStreaming: boolean }).isStreaming = true;
		publish({ state: "working" });
		const event: AgentSessionEvent = { type: "agent_start" };
		host.programStatus.handleEvent(event);
		progress.push(true);
	};
	const settle = async (phase: ApplicationPhase) => {
		publish(phase);
		(session as { isStreaming: boolean }).isStreaming = false;
		const event: AgentSessionEvent = { type: "agent_settled", aborted: false };
		host.programStatus.handleEvent(event);
		await handleRunStateEvent(host, event);
	};
	const state = () => statuses.at(-1)?.state;
	return { host, port, progress, publish, start, settle, state, stop, clear: vi.mocked(host.clearStatusIndicator) };
}

const waiting: ApplicationPhase = { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 };

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

	it("keeps both on for a timer that is still due, and clears the progress for a stopped phase", async () => {
		const t = setup();
		await t.start();
		await t.settle({ state: "scheduled", timers: 1, id: "t1", dueAt: 10 });
		expect(t.progress.at(-1)).toBe(true);
		expect(t.state()).toBe("working");
		t.publish({ state: "stopped", open: ["B1"] });
		expect(t.progress.at(-1)).toBe(false);
		expect(t.state()).toBe("done");
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
