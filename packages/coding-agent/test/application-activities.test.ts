import { afterEach, expect, it } from "vitest";
import type { ApplicationEvent, ApplicationFrame } from "@octocodeai/octocode-contacts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { getApplicationPort, type ApplicationService } from "../src/core/application/index.ts";
import { ApplicationActivities } from "../src/core/application/service/activities.ts";
import { createApplicationState } from "../src/core/application/state.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { APPLICATION_EVENT_ROUTES } from "../src/core/application/service/activity-data.ts";
import { createHarness } from "./suite/harness.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { ExtensionAPI } from "../src/index.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});
function fixture(entries: unknown[] = [], messages: unknown[] = []) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "activities",
		messages,
		isStreaming: false,
		sessionManager: { getBranch: () => entries },
		subscribe(callback: typeof listener) {
			listener = callback;
			return () => {};
		},
	} as unknown as AgentSession;
	const service = getApplicationPort(session);
	services.push(service);
	const events: ApplicationEvent[] = [];
	service.subscribe((event) => events.push(event));
	return { service, session, events, emit: (event: unknown) => listener?.(event as AgentSessionEvent) };
}
async function snapshot(service: ApplicationService) {
	const connection = service.connect();
	const frame = (await connection[Symbol.asyncIterator]().next()).value as ApplicationFrame;
	connection.close();
	if (frame.type !== "snapshot") throw new Error(`Expected snapshot, got ${frame.type}`);
	return frame.snapshot;
}
const base = { parentId: null, timestamp: "2026-01-01T00:00:00Z" };
const usage = {
	input: 3,
	output: 4,
	cacheRead: 5,
	cacheWrite: 6,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

it("restores persisted active-branch metadata, pages older entries and clears live notices on branch reset", async () => {
	const entries = Array.from({ length: 65 }, (_, id) => ({
		...base,
		id: String(id),
		type: "usage",
		kind: "cache_warm",
		provider: "provider",
		model: "model",
		usage,
	}));
	const f = fixture(entries);
	const state = await snapshot(f.service);
	expect(state.activities).toHaveLength(50);
	expect(state.activities?.[0]).toMatchObject({ id: "entry:15", entryId: "15", source: "session", data: { usage } });
	expect(state).toMatchObject({ activityBefore: "entry:15", hasMoreActivities: true });
	expect(f.service.history({ activityBefore: state.activityBefore }).activities).toHaveLength(15);
	expect(f.service.history({ activityBefore: "entry:15" }).hasMoreActivities).toBe(false);
	expect(() => f.service.history({ activityBefore: "other-branch" })).toThrow("Activity cursor");
	f.emit({ type: "auto_retry_end", success: true, attempt: 1 });
	expect((await snapshot(f.service)).activities?.at(-1)?.source).toBe("live");
	expect((await snapshot(fixture(entries).service)).activities).toEqual(state.activities);
	entries.splice(0, entries.length);
	Object.assign(f.session, { messages: [] });
	f.emit({ type: "session_context_changed" });
	expect(f.events.at(-1)).toMatchObject({ type: "session.reset", activities: [], hasMoreActivities: false });
	expect(f.service.history().activities).toEqual([]);
});

it("projects every native activity kind without duplicating raw message/provider or private session state", async () => {
	const f = fixture();
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinkingSignature: "PRIVATE_SIGNATURE" }],
		stopReason: "stop",
	};
	const cases = [
		{ type: "turn_start" },
		{ type: "turn_end", message, toolResults: [{ isError: true }] },
		{ type: "agent_end", messages: [message], willRetry: true },
		{ type: "session_info_changed", name: "Name" },
		{ type: "thinking_level_changed", level: "high" },
		{ type: "compaction_start", reason: "manual" },
		{
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			result: {
				summary: "Summary",
				tokensBefore: 20,
				firstKeptEntryId: "kept",
				estimatedTokensAfter: 5,
				usage,
				details: { private: "PRIVATE_STATE" },
				systemMessage: "PRIVATE_SYSTEM",
			},
		},
		{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100, errorMessage: "busy" },
		{ type: "auto_retry_end", success: false, attempt: 3, finalError: "busy" },
		{ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 2, delayMs: 50, errorMessage: "busy" },
		{ type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" },
		{ type: "summarization_retry_finished" },
		{ type: "bash_execution_update", id: "shell", delta: "out" },
		{
			type: "entry_appended",
			entry: { ...base, id: "custom", type: "custom", customType: "extension", data: { private: "PRIVATE_STATE" } },
		},
	];
	for (const event of cases) f.emit(event);
	const activities = (await snapshot(f.service)).activities!;
	expect(activities).toHaveLength(cases.length);
	expect(activities.find((item) => item.kind === "turn_end")?.data).toEqual({
		role: "assistant",
		stopReason: "stop",
		toolResultCount: 1,
		failedToolCount: 1,
	});
	expect(activities.find((item) => item.kind === "auto_retry_start")?.data).toMatchObject({
		delayMs: 100,
		errorMessage: "busy",
	});
	expect(JSON.stringify(activities)).not.toContain("PRIVATE_");
	expect(
		Object.entries(APPLICATION_EVENT_ROUTES)
			.filter(([, owner]) => owner.includes("activity"))
			.map(([kind]) => kind)
			.sort(),
	).toEqual(cases.map((event) => event.type).sort());
});

it("retains semantic entry fields while withholding private continuations, system prompts and extension state", async () => {
	const entries = [
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "model_change", provider: "p", modelId: "m" },
		{ type: "session_info", name: "Session" },
		{ type: "label", targetId: "target", label: "label" },
		{ type: "context_edit", targetId: "target", replacement: { content: "PRIVATE_EDIT" } },
		{
			type: "compaction",
			summary: "Visible summary",
			firstKeptEntryId: "first",
			tokensBefore: 100,
			systemBase: "PRIVATE_BASE",
			systemMessage: "PRIVATE_PROMPT",
			usage,
		},
		{ type: "branch_summary", fromId: "from", summary: "Branch", usage, fromHook: true },
		{ type: "custom_message", customType: "hidden", content: "PRIVATE_MESSAGE", display: false },
	].map((entry, index) => ({ ...base, id: String(index), ...entry }));
	const state = await snapshot(fixture(entries).service);
	expect(state.activities).toHaveLength(7);
	expect(JSON.stringify(state.activities)).not.toContain("PRIVATE_");
	expect(state.activities?.[4].data).toEqual({ targetId: "target", operation: "replace" });
	expect(state.activities?.[5].data).toMatchObject({ firstKeptEntryId: "first", tokensBefore: 100, usage });
	expect(state.activities?.[6].data).toMatchObject({ fromId: "from", fromHook: true });
});

it("stores large activity metadata and cumulative shell text behind full assets with stable revisions", async () => {
	const f = fixture();
	const name = "n".repeat(10000);
	f.emit({ type: "session_info_changed", name });
	f.emit({ type: "bash_execution_update", id: "one", delta: "a".repeat(6000) });
	const first = (await snapshot(f.service)).activities!;
	expect(first.every((item) => JSON.stringify(item).length < 5000)).toBe(true);
	expect(JSON.parse(f.service.readAsset(first[0].full!.id)!.data)).toEqual({ name });
	f.emit({ type: "bash_execution_update", id: "one", delta: "b".repeat(6000) });
	const latest = (await snapshot(f.service)).activities!;
	expect(latest).toHaveLength(2);
	expect(latest[1].full?.id).toBe(first[1].full?.id);
	expect(latest[1].full?.revision).not.toBe(first[1].full?.revision);
	expect(f.service.readAsset(latest[1].full!.id)?.data).toBe("a".repeat(6000) + "b".repeat(6000));
});

it("keeps the prior shell value after asset capacity failure instead of retaining rejected chunks", () => {
	const assets = new ApplicationAssets({ memory: true });
	const activities = new ApplicationActivities(assets, createApplicationState());
	activities.project({ type: "bash_execution_update", id: "one", delta: "good" });
	expect(() =>
		activities.project({ type: "bash_execution_update", id: "one", delta: "x".repeat(33 * 1024 * 1024) }),
	).toThrow("32 MiB");
	expect(activities.project({ type: "bash_execution_update", id: "one", delta: " next" })?.text).toBe("good next");
	assets.clear();
});

it("preserves bash outcome/command and summary provenance in canonical message details", () => {
	const { service } = fixture();
	const bash = {
		role: "bashExecution",
		command: "false",
		output: "",
		exitCode: 1,
		cancelled: false,
		truncated: true,
		excludeFromContext: true,
		fullOutputPath: "/untrusted/path",
	};
	expect(service.normalizeMessage(bash)).toMatchObject({
		status: "failed",
		text: expect.stringContaining("$ false\n"),
		details: {
			command: "false",
			exitCode: 1,
			truncated: true,
			excludeFromContext: true,
			fullOutputPath: "/untrusted/path",
		},
	});
	expect(service.normalizeMessage(bash).content?.at(-1)).toMatchObject({
		type: "unsupported",
		providerType: "shell-output-unavailable",
	});
	expect(service.normalizeMessage({ ...bash, cancelled: true }).status).toBe("aborted");
	expect(service.normalizeMessage({ role: "branchSummary", summary: "Branch", fromId: "branch" }).details).toEqual({
		fromId: "branch",
	});
	expect(
		service.normalizeMessage({ role: "compactionSummary", summary: "Compact", tokensBefore: 100 }).details,
	).toEqual({ tokensBefore: 100 });
});

it("rebuilds oversized tool arguments after restart and emits changing full-message revisions", async () => {
	const args = { data: "x".repeat(70000) };
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [{ type: "toolCall", id: "large", name: "tool", arguments: args }],
		stopReason: "toolUse",
	};
	const result = {
		role: "toolResult",
		timestamp: 2,
		toolCallId: "large",
		toolName: "tool",
		content: [{ type: "text", text: "done" }],
		isError: false,
	};
	const f = fixture([], [message, result]);
	const tool = (await snapshot(f.service)).tools![0];
	expect(tool).toMatchObject({ toolCallId: "large", status: "completed", messageId: expect.any(String) });
	expect(JSON.parse(f.service.readAsset(tool.full!.id)!.data).arguments).toEqual(args);
	f.emit({
		type: "tool_execution_end",
		toolCallId: "large",
		toolName: "tool",
		result: { ...result, structuredContent: { data: "structured".repeat(5000) } },
		isError: false,
	});
	const updated = (await snapshot(f.service)).tools![0];
	const fullTool = JSON.parse(f.service.readAsset(updated.full!.id)!.data);
	expect(fullTool.arguments).toEqual(args);
	expect(JSON.parse(f.service.readAsset(fullTool.full.id)!.data).structuredContent).toEqual({
		data: "structured".repeat(5000),
	});
	const live = fixture();
	live.emit({ type: "message_start", message });
	live.emit({
		type: "message_update",
		message: { ...message, content: [{ ...message.content[0], arguments: { data: `${args.data}changed` } }] },
		assistantMessageEvent: { type: "toolcall_delta", delta: "changed" },
	});
	expect(live.events.at(-1)).toMatchObject({ type: "message.delta", full: { revision: expect.any(String) } });
	expect(
		JSON.parse(
			live.service.readAsset((live.events.at(-1) as Extract<ApplicationEvent, { type: "message.delta" }>).full!.id)!
				.data,
		).content[0].arguments.data,
	).toBe(`${args.data}changed`);
});

it("keeps combined populated snapshots below the stream queue budget", async () => {
	const entries = Array.from({ length: 70 }, (_, id) => ({
		...base,
		id: String(id),
		type: "usage",
		kind: "cache_warm",
		note: "n".repeat(3500),
		provider: "p",
		model: "m",
		usage,
	})) as SessionEntry[];
	const messages = Array.from({ length: 50 }, (_, timestamp) => ({
		role: "assistant",
		timestamp,
		content: [{ type: "text", text: "m".repeat(3800) }],
	}));
	const f = fixture(entries, messages);
	for (let i = 0; i < 40; i++)
		f.emit({
			type: "tool_execution_end",
			toolCallId: String(i),
			toolName: "tool",
			result: { content: [{ type: "text", text: "t".repeat(3800) }] },
			isError: false,
		});
	f.emit({ type: "queue_update", steering: ["q".repeat(30000)], followUp: ["f".repeat(30000)] });
	for (let i = 0; i < 10; i++)
		f.service.publishDomain({
			type: "application.error",
			id: String(i),
			code: "content-unavailable",
			message: "e".repeat(1000),
		});
	const state = await snapshot(f.service);
	expect(JSON.stringify(state).length).toBeLessThan(240000);
	expect(state.hasMoreActivities).toBe(true);
	expect(f.service.history({ limit: 100 }).activities).toHaveLength(70);
});

it("publishes real model and label changes immediately with persisted activity identities", async () => {
	let extension: ExtensionAPI | undefined;
	const harness = await createHarness({
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
		],
		extensionFactories: [
			(api) => {
				extension = api;
			},
		],
	});
	const service = getApplicationPort(harness.session);
	try {
		const events: ApplicationEvent[] = [];
		service.subscribe((event) => events.push(event));
		await harness.session.setModel(harness.getModel("faux-2")!);
		const entry = harness.sessionManager.getBranch().findLast((item) => item.type === "model_change")!;
		expect(events.at(-1)).toMatchObject({
			type: "session.activity",
			activity: { id: `entry:${entry.id}`, kind: "model_change", source: "session", data: { modelId: "faux-2" } },
		});
		extension!.setLabel(entry.id, "selection");
		expect(events.at(-1)).toMatchObject({
			type: "session.activity",
			activity: { kind: "label", source: "session", data: { targetId: entry.id, label: "selection" } },
		});
	} finally {
		service.dispose();
		harness.cleanup();
	}
});

it("assigns distinct native execution IDs to concurrent anonymous shells", async () => {
	const harness = await createHarness();
	try {
		const ids: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "bash_execution_update") ids.push(event.id!);
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("out"));
				return { exitCode: 0 };
			},
		};
		await Promise.all([
			harness.session.executeBash("one", undefined, { operations }),
			harness.session.executeBash("two", undefined, { operations }),
		]);
		expect(ids).toHaveLength(2);
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(2);
	} finally {
		harness.cleanup();
	}
});
