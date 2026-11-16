import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import {
	ApplicationProjection,
	activityCard,
	connectionTone,
	EventInterner,
	groupFeed,
	latestProgress,
	mergeEvents,
	runPhase,
	settleToolStarts,
	stripAnsi,
	terminalEntries,
} from "../src/app/live/model.ts";

const session = (overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot => ({
	sessionId: "s",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
	...overrides,
});

describe("activity cards", () => {
	it("shows the host's typed-result failure while retaining the original child status", () => {
		expect(
			activityCard({
				id: 1,
				at: 0,
				type: "agent.result",
				text: "Checked",
				outcome: "failed",
				details: {
					summary: "Checked",
					body: "Structured result: invalid (schema).",
					status: "done",
					structured: { version: 1, schemaHash: "abc", status: "invalid" },
				},
			}),
		).toMatchObject({ failed: true, tone: "danger", status: "done", body: "Structured result: invalid (schema)." });
	});

	it("titles structured agent results from their summary and flags blocked outcomes", () => {
		const card = activityCard({
			id: 1,
			at: 0,
			type: "agent.result",
			text: "raw",
			details: { summary: "Refactor done", body: "## Notes", status: "blocked", files: ["a.ts"] },
		});
		expect(card).toMatchObject({
			tone: "danger",
			label: "Needs attention",
			title: "Refactor done",
			body: "## Notes",
			files: ["a.ts"],
		});
	});
	it("splits tool output into a title line and body", () => {
		expect(activityCard({ id: 2, at: 0, type: "tool.result", text: "read\nline 1\nline 2" })).toMatchObject({
			tone: "success",
			label: "Tool result",
			title: "read",
			body: "line 1\nline 2",
			files: [],
		});
		expect(activityCard({ id: 3, at: 0, type: "message", text: "Hello" })).toMatchObject({
			tone: "neutral",
			title: "Agent message",
			body: "Hello",
		});
	});
});

describe("application projection", () => {
	it("keeps the host's order of messages and tools from one snapshot", () => {
		const projection = new ApplicationProjection();
		const events = projection.update(
			session({
				messages: [
					{ id: "a", role: "assistant", text: "First answer", complete: true, order: 0 },
					{ id: "b", role: "assistant", text: "Second answer", complete: true, order: 2 },
				],
				tools: [{ toolCallId: "t", toolName: "read", text: "ok", status: "completed", order: 1 }],
			}),
			10,
		);
		const firstLines = (list: readonly { text: string }[]) => list.map((event) => event.text.split("\n")[0]);
		expect(firstLines(events)).toEqual(["First answer", "read", "Second answer"]);
		// They share the snapshot's time, so the feed's time sort keeps that order.
		const feed = mergeEvents({ sessionId: "s", events: [] } as never, events, "s").events;
		expect(firstLines(feed)).toEqual(["First answer", "read", "Second answer"]);
	});

	it("keeps stable ids and first-seen times while messages stream", () => {
		const projection = new ApplicationProjection();
		const first = projection.update(
			session({ messages: [{ id: "m", role: "assistant", text: "Par", complete: false }] }),
			10,
		);
		const second = projection.update(
			session({
				messages: [
					{ id: "m", role: "assistant", text: "Partial", complete: true },
					{ id: "u", role: "user", text: "Follow-up", complete: true },
				],
				tools: [{ toolCallId: "t", toolName: "read", text: "ok", status: "failed" }],
			}),
			20,
		);
		expect(first[0]).toMatchObject({ id: -1, at: 10, details: { status: "streaming" } });
		expect(second.find((event) => event.type === "message")).toMatchObject({
			id: -1,
			at: 10,
			text: "Partial",
			details: { status: "completed" },
		});
		expect(second.find((event) => event.type === "tool.result")).toMatchObject({
			id: -3,
			outcome: "failed",
			text: "read\nok",
		});
		expect(second.find((event) => event.message?.role === "user")).toMatchObject({ id: -2, text: "Follow-up" });
		expect(projection.update(session(), 30)).toEqual([]);
	});
	it("forgets events from another session", () => {
		const projection = new ApplicationProjection();
		projection.update(session({ messages: [{ id: "m", role: "assistant", text: "a", complete: true }] }), 1);
		const next = projection.update(
			session({ sessionId: "other", messages: [{ id: "m", role: "assistant", text: "b", complete: true }] }),
			5,
		);
		expect(next[0]).toMatchObject({ at: 5, text: "b" });
	});
	it("merges by time, keeps the latest 200, and drops events for another session", () => {
		const domain = {
			sessionId: "s",
			agents: [],
			traffic: [],
			receipts: [],
			events: [{ id: 1, at: 5, type: "session", text: "x" }],
		};
		const app = [{ id: -1, at: 1, type: "message", text: "y" }];
		expect(mergeEvents(domain, app, "s").events.map((event) => event.id)).toEqual([-1, 1]);
		expect(mergeEvents(domain, app, "other").events.map((event) => event.id)).toEqual([1]);
	});
});

describe("connection tone", () => {
	it("classifies transport messages", () => {
		expect(connectionTone("Disconnected · reconnecting…")).toBe("connecting");
		expect(connectionTone("Refreshing session state…")).toBe("connecting");
		expect(connectionTone("Access or protocol expired — reopen /backlog.")).toBe("error");
	});
});

describe("render efficiency", () => {
	it("reuses unchanged event objects so memoized rows skip re-rendering", () => {
		const interner = new EventInterner();
		const first = interner.intern([{ id: 1, at: 0, type: "message", text: "a" }]);
		const second = interner.intern([
			{ id: 1, at: 0, type: "message", text: "a" },
			{ id: 2, at: 1, type: "message", text: "b" },
		]);
		expect(second[0]).toBe(first[0]);
		const third = interner.intern([{ id: 1, at: 0, type: "message", text: "changed" }]);
		expect(third[0]).not.toBe(first[0]);
	});
	it("keeps a streaming projection's untouched events identical between deltas", () => {
		const projection = new ApplicationProjection();
		const base = { id: "done", role: "assistant" as const, text: "final", complete: true };
		const first = projection.update(
			session({ messages: [base, { id: "live", role: "assistant", text: "a", complete: false }] }),
			1,
		);
		const second = projection.update(
			session({ messages: [base, { id: "live", role: "assistant", text: "ab", complete: false }] }),
			2,
		);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
	});
	it("groups consecutive tool events and summarizes their state", () => {
		const feed = groupFeed([
			{ id: 5, at: 5, type: "message", text: "m" },
			{ id: 4, at: 4, type: "tool.start", text: "grep" },
			{ id: 3, at: 3, type: "tool.result", text: "read" },
			{ id: 2, at: 2, type: "tool.result", text: "edit", outcome: "failed" },
			{ id: 1, at: 1, type: "tool.result", text: "solo" },
			{ id: 0, at: 0, type: "session", text: "s" },
		]);
		expect(feed.map((entry) => entry.kind)).toEqual(["event", "tools", "event"]);
		const group = feed[1];
		expect(group.kind === "tools" && group.summary).toEqual({ total: 4, running: 1, failed: 1, done: 3, notRun: 0 });
		expect(groupFeed([{ id: 1, at: 1, type: "tool.result", text: "solo" }])[0].kind).toBe("event");
	});
});

describe("run phase and thinking", () => {
	it("derives what a running session is doing from its snapshot", () => {
		expect(runPhase(undefined)).toEqual({ kind: "idle" });
		expect(runPhase(session({ streaming: false }))).toEqual({ kind: "idle" });
		expect(
			runPhase(session({ streaming: true, messages: [{ id: "u", role: "user", text: "go", complete: true }] })),
		).toEqual({
			kind: "thinking",
		});
		expect(
			runPhase(session({ streaming: true, messages: [{ id: "a", role: "assistant", text: "Hel", complete: false }] })),
		).toEqual({ kind: "writing" });
		expect(
			runPhase(
				session({
					streaming: true,
					messages: [{ id: "a", role: "assistant", text: "Hel", complete: false }],
					tools: [{ toolCallId: "t", toolName: "bash", text: "npm test", status: "running" }],
				}),
			),
		).toEqual({ kind: "tool", name: "bash" });
	});
	it("records how long the run thought before its first answer", () => {
		const projection = new ApplicationProjection();
		projection.update(session({ streaming: true, runId: "r1" }), 1_000);
		expect(projection.run).toEqual({ id: "r1", startedAt: 1_000 });
		const first = projection.update(
			session({
				streaming: true,
				runId: "r1",
				messages: [{ id: "m1", role: "assistant", text: "a", complete: false }],
			}),
			13_500,
		);
		expect(first[0].details).toMatchObject({ thoughtMs: 12_500 });
		const later = projection.update(
			session({
				streaming: true,
				runId: "r1",
				messages: [
					{ id: "m1", role: "assistant", text: "ab", complete: true },
					{ id: "m2", role: "assistant", text: "c", complete: false },
				],
			}),
			20_000,
		);
		expect(later[0].details).toMatchObject({ thoughtMs: 12_500 });
		expect(later[1].details).not.toHaveProperty("thoughtMs");
		projection.update(session({ streaming: false }), 21_000);
		expect(projection.run).toBeUndefined();
	});
});

describe("terminal transcript", () => {
	it("turns tool events into chronological command entries", () => {
		const entries = terminalEntries([
			{ id: 1, at: 1, type: "message", text: "ignored" },
			{ id: 2, at: 2, type: "tool.result", text: "bash\n\u001b[32mok\u001b[0m 3 tests" },
			{ id: 3, at: 3, type: "tool.result", text: "edit", outcome: "failed" },
			{ id: 4, at: 4, type: "tool.start", text: "grep\naria-modal" },
		]);
		expect(entries).toEqual([
			{ id: 2, at: 2, command: "bash", output: "ok 3 tests", status: "done" },
			{ id: 3, at: 3, command: "edit", output: "", status: "failed" },
			{ id: 4, at: 4, command: "grep", output: "aria-modal", status: "running" },
		]);
	});
	it("strips terminal colour codes without touching other text", () => {
		expect(stripAnsi("\u001b[1;31merror\u001b[0m: [x]")).toBe("error: [x]");
	});
	it("strips OSC hyperlinks and window titles, keeping the link text", () => {
		expect(stripAnsi("\u001b]8;;https://example.com\u001b\\docs\u001b]8;;\u001b\\ here")).toBe("docs here");
		expect(stripAnsi("\u001b]0;title\u0007output")).toBe("output");
	});
});

describe("tool calls as the host really sends them", () => {
	it("never mistakes streamed progress output for arguments (the host sends none with tool.started)", () => {
		const projection = new ApplicationProjection();
		const [started] = projection.update(
			session({ tools: [{ toolCallId: "t", toolName: "bash", text: "", status: "running" }] }),
			1,
		);
		expect(terminalEntries([started])[0]).toMatchObject({ command: "bash", output: "", status: "running" });
		const [progress] = projection.update(
			session({ tools: [{ toolCallId: "t", toolName: "bash", text: "Running 3 tests", status: "running" }] }),
			2,
		);
		expect(terminalEntries([progress])[0]).toMatchObject({
			command: "bash",
			output: "Running 3 tests",
			status: "running",
		});
		const [done] = projection.update(
			session({ tools: [{ toolCallId: "t", toolName: "bash", text: "3 passed", status: "completed" }] }),
			3,
		);
		expect(done.details).not.toHaveProperty("args");
		expect(terminalEntries([done])).toEqual([
			{ id: done.id, at: 1, command: "bash", output: "3 passed", status: "done" },
		]);
	});

	it("pairs each workspace tool.start with its later tool.result so finished calls stop running", () => {
		const events = settleToolStarts([
			{ id: 1, at: 1, type: "tool.start", text: "bash", details: { id: "c1" } },
			{ id: 2, at: 2, type: "tool.start", text: "file", details: { id: "c2" } },
			{ id: 3, at: 3, type: "tool.result", text: "bash failed\nexit 1", outcome: "failed" },
			{ id: 4, at: 4, type: "tool.start", text: "bash", details: { id: "c3" } },
			{ id: 5, at: 5, type: "message", text: "hi" },
		]);
		expect(events.map((event) => event.id)).toEqual([2, 3, 4, 5]);
		expect(terminalEntries(events)).toEqual([
			{ id: 2, at: 2, command: "file", output: "", status: "running" },
			{ id: 3, at: 3, command: "bash", output: "exit 1", status: "failed" },
			{ id: 4, at: 4, command: "bash", output: "", status: "running" },
		]);
		expect(groupFeed([...events].reverse()).find((entry) => entry.kind === "tools")).toMatchObject({
			summary: { total: 3, running: 2, failed: 1, done: 1, notRun: 0 },
		});
	});

	it("titles failed workspace results by tool name and strips colour codes from output", () => {
		const card = activityCard({
			id: 1,
			at: 0,
			type: "tool.result",
			text: "bash failed\n\u001b[31merror\u001b[0m TS2322",
			outcome: "failed",
		});
		expect(card).toMatchObject({ title: "bash", body: "error TS2322", label: "Needs attention" });
	});
});

describe("per-tool rendering", () => {
	it("keeps only the latest progress line per agent instead of flooding the feed", () => {
		const progress = (id: number, agent: string | undefined, text: string) => ({
			id,
			at: id,
			type: "agent.progress",
			text,
			details: agent ? { id: agent, status: "running" } : undefined,
		});
		const events = latestProgress([
			progress(1, "kraken", "→ bash ls"),
			progress(2, "kraken", "→ bash ls"),
			progress(3, "squid", "→ file edit"),
			{ id: 4, at: 4, type: "tool.result", text: "bash\nok" },
			progress(5, "kraken", "→ read a.ts"),
			progress(6, undefined, "waiting for a slot (2 running)"),
			progress(7, undefined, "waiting for a slot (1 running)"),
		]);
		expect(events.map((event) => event.id)).toEqual([3, 4, 5, 7]);
	});
});

describe("tool hints", () => {
	it("labels application tool calls with the host's argument hint", () => {
		const [running] = new ApplicationProjection().update(
			session({ tools: [{ toolCallId: "t", toolName: "bash", hint: "npm test", text: "", status: "running" }] }),
			1,
		);
		expect(terminalEntries([running])[0]).toMatchObject({ command: "bash npm test", output: "" });
		expect(activityCard(running).title).toBe("bash npm test");
	});
	it("carries a workspace start's hint onto the result that settles it", () => {
		const [result] = settleToolStarts([
			{ id: 1, at: 1, type: "tool.start", text: "file", details: { id: "c1", hint: "src/a.ts" } },
			{ id: 2, at: 2, type: "tool.result", text: "file\n1. OK edit src/a.ts", details: { outcomes: [] } },
		]);
		expect(terminalEntries([result])[0]).toMatchObject({ command: "file src/a.ts", output: "1. OK edit src/a.ts" });
		expect(result.details).toEqual({ outcomes: [] });
	});
});

describe("assistant message placeholders", () => {
	it("drops tool-call and hidden-content placeholders that the feed already shows as tool events", () => {
		const projection = new ApplicationProjection();
		const events = projection.update(
			session({
				messages: [
					{ id: "a", role: "assistant", text: "[Content available in the session][Tool call: write]", complete: true },
					{ id: "b", role: "assistant", text: "Let me check.[Tool call: read]", complete: true },
					{ id: "c", role: "assistant", text: "See [Image attachment: open the session to view]", complete: true },
				],
			}),
			1,
		);
		expect(events.map((event) => event.text)).toEqual([
			"Let me check.",
			"See [Image attachment: open the session to view]",
		]);
	});
});

describe("tool names", () => {
	it("shows MCP tools as server/tool, the host's own label for them", () => {
		const [entry] = terminalEntries([
			{ id: 1, at: 1, type: "tool.result", text: "mcp__octocode__localSearch\n3 matches" },
		]);
		expect(entry.command).toBe("octocode/localSearch");
		expect(activityCard({ id: 2, at: 1, type: "tool.result", text: "mcp__my_server__read_doc\nok" }).title).toBe(
			"my_server/read_doc",
		);
	});
});

describe("agent reports in the feed", () => {
	it("renders an agent tool's report as Markdown while other tool output stays literal", () => {
		expect(activityCard({ id: 1, at: 0, type: "tool.result", text: "agent\n## Findings\n- ok" })).toMatchObject({
			markdown: true,
			body: "## Findings\n- ok",
		});
		expect(activityCard({ id: 2, at: 0, type: "tool.result", text: "bash\n# not a heading" }).markdown).toBe(false);
	});
});
