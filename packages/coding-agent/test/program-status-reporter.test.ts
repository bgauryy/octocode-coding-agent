import type { ActivityFacts } from "@octocodeai/octocode-projections";
import type { ProgramStatus, Terminal } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { SessionStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";

/**
 * Contract change (RFC 2026-11-23-app-state, T2): the reporter keeps no run or compaction state machine of its own. It
 * reports the activity light of the session's application state facts, which carry the run (`streaming`), compaction
 * and retries (`status`), the dialog (`awaiting`) and the job's outcome (`phase`). The outcomes below are the ones the
 * event-driven reporter gave, now read from those facts.
 */
function setup(sessionName?: string) {
	const reports: ProgramStatus[] = [];
	const terminal = { setProgramStatus: (status: ProgramStatus) => reports.push(status) } as unknown as Terminal;
	const session = { name: sessionName };
	const reporter = new SessionStatusReporter(
		() => terminal,
		() => session.name,
	);
	const facts = (next: ActivityFacts) => reporter.setPhase({ status: "idle", streaming: false, ...next });
	const last = () => {
		const { app: _app, ...status } = reports.at(-1)!;
		return Object.fromEntries(Object.entries(status).filter(([, value]) => value !== undefined));
	};
	return { reporter, reports, session, facts, last };
}

describe("SessionStatusReporter", () => {
	it("reports idle before any facts, working during a run, and done once the job ended well", () => {
		const { reporter, reports, facts, last } = setup("Fix login");
		reporter.report();
		expect(reports.at(-1)).toEqual({ state: "idle", app: "octocode" });
		facts({ streaming: true, phase: { state: "working" } });
		expect(last()).toEqual({ state: "working", message: "Fix login" });
		facts({ phase: { state: "done" } });
		expect(last()).toEqual({ state: "done", message: "Fix login" });
	});

	it("reports a failed job's first error line, a stopped job's open items, and an aborted one as idle", () => {
		const { facts, last } = setup();
		facts({ phase: { state: "failed", error: "Invalid API key\n{details}" } });
		expect(last()).toEqual({ state: "error", message: "Invalid API key" });
		facts({ phase: { state: "stopped", open: ["B1", "B2"] } });
		expect(last()).toEqual({ state: "error", message: "Stopped: B1, B2 still open" });
		facts({ phase: { state: "idle" } });
		expect(last()).toEqual({ state: "idle" });
	});

	it("reports compaction as compacting context, and a retry or a quiet model as the session working", () => {
		const { facts, last } = setup("Session");
		facts({ streaming: true, status: "compacting" });
		expect(last()).toEqual({ state: "working", message: "Compacting context" });
		facts({ status: "compacting" });
		expect(last()).toEqual({ state: "working", message: "Compacting context" });
		facts({ streaming: true, status: "retrying" });
		expect(last()).toEqual({ state: "working", message: "Session" });
		facts({ streaming: true, status: "stalled" });
		expect(last()).toEqual({ state: "working", message: "Session" });
	});

	it("reports the session's dialog with its kind, and a pending timer alone as idle (decision Q1)", () => {
		const { facts, last } = setup();
		facts({ streaming: true, awaiting: { kind: "approval", title: "Run bash?" } });
		expect(last()).toEqual({ state: "blocked", kind: "permission", message: "Run bash?" });
		facts({ awaiting: { kind: "question", title: "Which branch?" } });
		expect(last()).toEqual({ state: "blocked", kind: "question", message: "Which branch?" });
		facts({ phase: { state: "blocked", title: "child asks" } });
		expect(last()).toEqual({ state: "blocked", kind: "question", message: "child asks" });
		facts({ phase: { state: "scheduled", timers: 1, id: "t1", dueAt: 10 } });
		expect(last()).toEqual({ state: "idle" });
	});

	it("reports the most recent open host dialog over the facts, and the facts once all close", () => {
		const { reporter, facts, last } = setup();
		facts({ streaming: true });
		reporter.setBlocked("feature-dialog", { kind: "permission", message: "Allow bash?" });
		reporter.setBlocked("login", { kind: "auth", message: "Log in to Anthropic" });
		expect(last()).toEqual({ state: "blocked", kind: "auth", message: "Log in to Anthropic" });
		reporter.setBlocked("login", undefined);
		facts({ phase: { state: "done" } });
		expect(last()).toEqual({ state: "blocked", kind: "permission", message: "Allow bash?" });
		// Reopening a source replaces its dialog instead of stacking a second one.
		reporter.setBlocked("feature-dialog", { kind: "question", message: "Pick one" });
		expect(last()).toEqual({ state: "blocked", kind: "question", message: "Pick one" });
		reporter.setBlocked("feature-dialog", undefined);
		expect(last()).toEqual({ state: "done" });
	});

	it("sends each status once and follows session name changes", () => {
		const { reporter, reports, session, facts, last } = setup("Old");
		facts({ streaming: true });
		facts({ streaming: true, phase: { state: "working", activity: "Reading files" } });
		reporter.report();
		expect(reports).toHaveLength(1);
		session.name = "New";
		reporter.handleEvent({ type: "session_info_changed", name: "New" });
		expect(last()).toEqual({ state: "working", message: "New" });
	});

	it("returns to idle when the session is replaced", () => {
		const { reporter, facts, last } = setup();
		facts({ phase: { state: "done" } });
		reporter.reset();
		expect(last()).toEqual({ state: "idle" });
	});
});
