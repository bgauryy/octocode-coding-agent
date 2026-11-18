import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	APPLICATION_PROTOCOL_VERSION,
	ApplicationCommandSchema,
	ApplicationCursorSchema,
	ApplicationEventSchema,
	ApplicationSnapshotSchema,
	ApplicationToolSchema,
	applicationCommandFingerprint,
	parseApplicationFrame,
	type ApplicationCommand,
	type ApplicationFrame,
} from "../src/application.ts";
import {
	BacklogRefSchema,
	CompletionSchema,
	EntityFieldsSchema,
	ITEM_TYPES,
	LinkSchema,
	ReferenceSchema,
} from "../src/backlogs.ts";
import { BacklogMutationSchema, WorkspaceCommandSchema, WORKSPACE_ROUTES } from "../src/protocol.ts";
import { StringEnum } from "../src/schema.ts";
import { STATES } from "../src/snapshot.ts";

const cursor = { sessionId: "session", epoch: "epoch", sequence: 0 };
const message = { id: "m1", role: "assistant", text: "hi", complete: true };
const tool = { toolCallId: "t1", toolName: "read", text: "", status: "running" as const };
const snapshot = {
	sessionId: "session",
	messages: [message],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt", "abort"] as const,
};
const completion = {
	summary: "Done",
	files: [{ path: "src/a.ts", role: "changed" as const }],
	verification: { status: "passed" as const, summary: "tests pass" },
	operationKey: "op-1",
};

describe("StringEnum", () => {
	it("emits a plain string enum (no anyOf/const) and validates membership", () => {
		const schema = StringEnum(["a", "b"] as const, { description: "letters", default: "a" });
		expect(schema).toMatchObject({ type: "string", enum: ["a", "b"], description: "letters", default: "a" });
		expect(JSON.stringify(schema)).not.toMatch(/anyOf|const/);
		expect(Value.Check(schema, "b")).toBe(true);
		expect(Value.Check(schema, "c")).toBe(false);
		expect(Value.Check(schema, 1)).toBe(false);
	});

	it("omits description and default keys when not given", () => {
		const schema = StringEnum(["x"] as const);
		expect(Object.keys(schema)).not.toContain("description");
		expect(Object.keys(schema)).not.toContain("default");
	});

	it("preserves an explicitly supplied empty description and enum default", () => {
		const defaultValue = "";
		const schema = StringEnum(["", "value"] as const, { description: "", default: defaultValue });
		expect(schema).toMatchObject({ description: "", default: "" });
		expect(Value.Check(schema, defaultValue)).toBe(true);
	});
});

describe("ApplicationCommandSchema", () => {
	it("accepts steer, followUp and abort-with-runId and enforces id and text bounds", () => {
		const base = { id: "r", sessionId: "s" };
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "steer", text: "x" })).toBe(true);
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "followUp", text: "x" })).toBe(true);
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "abort", runId: "run" })).toBe(true);
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "abort", runId: "run", text: "x" })).toBe(false);
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "prompt", text: "" })).toBe(false);
		expect(Value.Check(ApplicationCommandSchema, { ...base, action: "prompt", text: "x".repeat(64001) })).toBe(false);
		expect(Value.Check(ApplicationCommandSchema, { ...base, id: "x".repeat(129), action: "prompt", text: "x" })).toBe(
			false,
		);
		expect(Value.Check(ApplicationCommandSchema, { ...base, sessionId: "", action: "prompt", text: "x" })).toBe(false);
	});

	it("fingerprint ignores key order and keeps only the action's payload field", () => {
		const a: ApplicationCommand = { text: "hello", action: "prompt", sessionId: "s", id: "r" };
		const b: ApplicationCommand = { id: "r", sessionId: "s", action: "prompt", text: "hello" };
		expect(applicationCommandFingerprint(a)).toBe(applicationCommandFingerprint(b));
		const abort: ApplicationCommand = { id: "r", sessionId: "s", action: "abort", runId: "run" };
		expect(JSON.parse(applicationCommandFingerprint(abort))).toEqual({
			id: "r",
			sessionId: "s",
			action: "abort",
			runId: "run",
		});
	});

	it("fingerprint differs when text, action or session differs", () => {
		const base: ApplicationCommand = { id: "r", sessionId: "s", action: "prompt", text: "hello" };
		const fp = applicationCommandFingerprint(base);
		expect(applicationCommandFingerprint({ ...base, text: "other" })).not.toBe(fp);
		expect(applicationCommandFingerprint({ ...base, action: "steer" })).not.toBe(fp);
		expect(applicationCommandFingerprint({ ...base, sessionId: "t" })).not.toBe(fp);
	});
});

describe("application schemas", () => {
	it("cursor rejects negative, fractional and missing sequence", () => {
		expect(Value.Check(ApplicationCursorSchema, cursor)).toBe(true);
		expect(Value.Check(ApplicationCursorSchema, { ...cursor, sequence: -1 })).toBe(false);
		expect(Value.Check(ApplicationCursorSchema, { ...cursor, sequence: 1.5 })).toBe(false);
		expect(Value.Check(ApplicationCursorSchema, { sessionId: "s", epoch: "e" })).toBe(false);
	});

	it("tool accepts optional non-negative integer order and rejects unknown status or long hint", () => {
		expect(Value.Check(ApplicationToolSchema, tool)).toBe(true);
		expect(Value.Check(ApplicationToolSchema, { ...tool, order: 0, hint: "src/a.ts" })).toBe(true);
		expect(Value.Check(ApplicationToolSchema, { ...tool, order: -1 })).toBe(false);
		expect(Value.Check(ApplicationToolSchema, { ...tool, order: 1.5 })).toBe(false);
		expect(Value.Check(ApplicationToolSchema, { ...tool, status: "queued" })).toBe(false);
		expect(Value.Check(ApplicationToolSchema, { ...tool, hint: "x".repeat(201) })).toBe(false);
		const { text: _text, ...withoutText } = tool;
		expect(Value.Check(ApplicationToolSchema, withoutText)).toBe(false);
	});

	it("message events accept optional order and reject negative order", () => {
		expect(Value.Check(ApplicationEventSchema, { type: "message.started", message })).toBe(true);
		expect(Value.Check(ApplicationEventSchema, { type: "message.completed", message: { ...message, order: 3 } })).toBe(
			true,
		);
		expect(Value.Check(ApplicationEventSchema, { type: "message.started", message: { ...message, order: -2 } })).toBe(
			false,
		);
		const { complete: _complete, ...incomplete } = message;
		expect(Value.Check(ApplicationEventSchema, { type: "message.started", message: incomplete })).toBe(false);
	});

	it("accepts every event variant with its required fields", () => {
		const events = [
			{ type: "message.delta", messageId: "m1", delta: "x", text: "hix" },
			{ type: "tool.progress", toolCallId: "t1", toolName: "bash", text: "..." },
			{ type: "tool.completed", toolCallId: "t1", toolName: "bash", failed: true },
			{ type: "run.started", runId: "r1" },
			{ type: "run.settled", runId: "r1", aborted: false },
			{ type: "queue.changed", steering: ["a"], followUp: [] },
			{ type: "session.status", status: "compacting" },
			{ type: "session.awaiting", awaiting: { kind: "approval", title: "Run bash?" } },
			{ type: "session.awaiting" },
			{
				type: "session.phase",
				phase: { state: "waiting", agents: 2, queued: 0, bash: 1, external: 0 },
				jobStartedAt: 5,
			},
			{ type: "session.phase", phase: { state: "done" } },
			{ type: "command.receipt", receipt: { id: "c1", status: "failed", message: "nope" } },
		];
		for (const event of events) expect(Value.Check(ApplicationEventSchema, event), event.type).toBe(true);
	});

	it("rejects events with wrong enum values or missing required fields", () => {
		const bad = [
			{ type: "run.settled", runId: "r1" },
			{ type: "session.status", status: "busy" },
			{ type: "session.awaiting", awaiting: { kind: "dialog" } },
			{ type: "session.awaiting", awaiting: { kind: "question", title: "x".repeat(201) } },
			{ type: "session.phase" },
			{ type: "session.phase", phase: { state: "sleeping" } },
			{ type: "session.phase", phase: { state: "waiting", agents: -1, queued: 0, bash: 0, external: 0 } },
			{ type: "session.phase", phase: { state: "failed" } },
			{ type: "command.receipt", receipt: { id: "c1", status: "rejected" } },
			{ type: "queue.changed", steering: "a", followUp: [] },
			{ type: "tool.started", toolName: "bash" },
		];
		for (const event of bad) expect(Value.Check(ApplicationEventSchema, event), JSON.stringify(event)).toBe(false);
	});

	it("snapshot accepts optional tools/status/runId and rejects unknown capabilities", () => {
		expect(Value.Check(ApplicationSnapshotSchema, snapshot)).toBe(true);
		expect(
			Value.Check(ApplicationSnapshotSchema, {
				...snapshot,
				tools: [{ ...tool, order: 1 }],
				status: "retrying",
				runId: "r1",
				awaiting: { kind: "question" },
			}),
		).toBe(true);
		expect(Value.Check(ApplicationSnapshotSchema, { ...snapshot, awaiting: { kind: "wait" } })).toBe(false);
		expect(Value.Check(ApplicationSnapshotSchema, { ...snapshot, capabilities: ["shell"] })).toBe(false);
		expect(Value.Check(ApplicationSnapshotSchema, { ...snapshot, status: "busy" })).toBe(false);
		const { receipts: _receipts, ...missing } = snapshot;
		expect(Value.Check(ApplicationSnapshotSchema, missing)).toBe(false);
	});
});

describe("application frames", () => {
	const frames: ApplicationFrame[] = [
		{
			protocolVersion: APPLICATION_PROTOCOL_VERSION,
			cursor,
			at: 1,
			type: "snapshot",
			snapshot: { ...snapshot, capabilities: ["prompt"] },
		},
		{
			protocolVersion: 1,
			cursor: { ...cursor, sequence: 1 },
			at: 2,
			type: "event",
			event: { type: "tool.started", toolCallId: "t1", toolName: "read", order: 2, hint: "a.ts" },
		},
		{ protocolVersion: 1, cursor, at: 3, type: "resumed" },
		{ protocolVersion: 1, cursor, at: 4, type: "resync", reason: "session-changed" },
	];

	it("every frame variant round-trips through JSON and still parses to an equal value", () => {
		for (const frame of frames) {
			const parsed = parseApplicationFrame(JSON.parse(JSON.stringify(frame)));
			expect(parsed, frame.type).toEqual(frame);
		}
	});

	it("rejects frames with unknown type, bad resync reason, or missing cursor", () => {
		expect(parseApplicationFrame({ protocolVersion: 1, cursor, at: 1, type: "ping" })).toBeUndefined();
		expect(
			parseApplicationFrame({ protocolVersion: 1, cursor, at: 1, type: "resync", reason: "boredom" }),
		).toBeUndefined();
		expect(parseApplicationFrame({ protocolVersion: 1, at: 1, type: "resumed" })).toBeUndefined();
		expect(parseApplicationFrame({ protocolVersion: 1, cursor, type: "resumed" })).toBeUndefined();
		expect(parseApplicationFrame(null)).toBeUndefined();
		expect(parseApplicationFrame("{}")).toBeUndefined();
	});
});

describe("backlog schemas", () => {
	it("references accept each resource kind and reject unknown resources or extra fields", () => {
		const valid = [
			{ resource: "backlogs", repositoryKey: "repo", id: "B1" },
			{ resource: "files", repositoryKey: "repo", path: "a.ts", revision: "abc" },
			{ resource: "reports", namespace: "ns", id: "r1" },
			{ resource: "external", url: "https://example.com" },
		];
		for (const ref of valid) expect(Value.Check(ReferenceSchema, ref), ref.resource).toBe(true);
		expect(Value.Check(ReferenceSchema, { resource: "tickets", namespace: "ns", id: "1" })).toBe(false);
		expect(Value.Check(ReferenceSchema, { resource: "external", url: "u", note: "x" })).toBe(false);
		expect(Value.Check(BacklogRefSchema, { resource: "backlogs", repositoryKey: "repo", id: "B1", extra: 1 })).toBe(
			false,
		);
		expect(Value.Check(BacklogRefSchema, { resource: "backlogs", id: "B1" })).toBe(false);
	});

	it("links require a known relation and a valid target", () => {
		const target = { resource: "external", url: "https://example.com" };
		expect(Value.Check(LinkSchema, { relation: "evidence", target })).toBe(true);
		expect(Value.Check(LinkSchema, { relation: "blocks", target })).toBe(false);
		expect(Value.Check(LinkSchema, { relation: "related", target: { resource: "external" } })).toBe(false);
	});

	it("completion requires summary, files, verification and operationKey and closes its objects", () => {
		expect(Value.Check(CompletionSchema, completion)).toBe(true);
		expect(Value.Check(CompletionSchema, { ...completion, lesson: "x", replaces: 2 })).toBe(true);
		const { operationKey: _key, ...noKey } = completion;
		expect(Value.Check(CompletionSchema, noKey)).toBe(false);
		expect(Value.Check(CompletionSchema, { ...completion, verification: { status: "skipped", summary: "" } })).toBe(
			false,
		);
		expect(Value.Check(CompletionSchema, { ...completion, files: [{ path: "a", role: "deleted" }] })).toBe(false);
		expect(Value.Check(CompletionSchema, { ...completion, files: [{ path: "a", role: "changed", size: 1 }] })).toBe(
			false,
		);
		expect(Value.Check(CompletionSchema, { ...completion, actor: "me" })).toBe(false);
	});

	it("entity fields accept null parent, mixed dependsOn and every item type", () => {
		for (const type of ITEM_TYPES) expect(Value.Check(EntityFieldsSchema, { type })).toBe(true);
		expect(
			Value.Check(EntityFieldsSchema, {
				parentId: null,
				dependsOn: ["B1", { resource: "backlogs", repositoryKey: "repo", id: "B2" }],
				completion,
				version: 3,
			}),
		).toBe(true);
		expect(Value.Check(EntityFieldsSchema, { type: "story" })).toBe(false);
		expect(Value.Check(EntityFieldsSchema, { parentId: "B1", bogus: 1 })).toBe(false);
		expect(Value.Check(EntityFieldsSchema, { version: 1.5 })).toBe(false);
		expect(Value.Check(EntityFieldsSchema, { reason: "why" })).toBe(false);
		expect(Value.Check(EntityFieldsSchema, { dependsOn: [{ resource: "files", repositoryKey: "r", path: "p" }] })).toBe(
			false,
		);
	});
});

describe("workspace protocol schemas", () => {
	it("backlog mutation takes why and refuses the removed reason and body names", () => {
		expect(Value.Check(BacklogMutationSchema, { op: "add", title: "t", reason: "r" })).toBe(false);
		expect(Value.Check(BacklogMutationSchema, { op: "add", title: "t", why: "w" })).toBe(true);
		expect(Value.Check(BacklogMutationSchema, { op: "add", title: "t", body: "b" })).toBe(false);
	});
	it("backlog mutation accepts every state and rejects priority outside 0..3 and unknown ops", () => {
		for (const state of STATES)
			expect(Value.Check(BacklogMutationSchema, { op: "update", id: "B1", state })).toBe(true);
		expect(Value.Check(BacklogMutationSchema, { op: "update", priority: 0 })).toBe(true);
		expect(Value.Check(BacklogMutationSchema, { op: "update", priority: 3 })).toBe(true);
		expect(Value.Check(BacklogMutationSchema, { op: "update", priority: -1 })).toBe(false);
		expect(Value.Check(BacklogMutationSchema, { op: "archive", id: "B1" })).toBe(false);
		expect(Value.Check(BacklogMutationSchema, { id: "B1" })).toBe(false);
		expect(Value.Check(BacklogMutationSchema, { op: "add", title: "x", assignee: "me" })).toBe(false);
	});

	it("workspace command bounds id length and text size", () => {
		expect(Value.Check(WorkspaceCommandSchema, { id: "x".repeat(128), action: "stop" })).toBe(true);
		expect(Value.Check(WorkspaceCommandSchema, { id: "x".repeat(129), action: "stop" })).toBe(false);
		expect(Value.Check(WorkspaceCommandSchema, { id: "", action: "stop" })).toBe(false);
		expect(Value.Check(WorkspaceCommandSchema, { id: "r", action: "message", text: "x".repeat(64001) })).toBe(false);
		expect(Value.Check(WorkspaceCommandSchema, { id: "r", action: "work", backlogId: "B1", version: 2 })).toBe(true);
		expect(Value.Check(WorkspaceCommandSchema, { id: "r", action: "work", version: 2.5 })).toBe(false);
	});

	it("workspace routes are all under /api and live is nested under backlogs", () => {
		for (const route of Object.values(WORKSPACE_ROUTES)) expect(route.startsWith("/api/")).toBe(true);
		expect(WORKSPACE_ROUTES.live.startsWith(`${WORKSPACE_ROUTES.backlogs}/`)).toBe(true);
	});
});
