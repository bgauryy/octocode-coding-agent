import { afterEach, expect, it } from "vitest";
import type { ApplicationFrame } from "@octocodeai/octocode-contracts";
import { getApplicationPort, type ApplicationService } from "../src/core/application/index.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationActivities } from "../src/core/application/service/activities.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { createApplicationState } from "../src/core/application/state.ts";

const open: ApplicationService[] = [];
afterEach(() => {
	for (const service of open.splice(0)) service.dispose();
});
function fixture(entries: unknown[] = []) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "stopped",
		messages: [],
		isStreaming: false,
		sessionManager: { getBranch: () => entries },
		subscribe(callback: typeof listener) {
			listener = callback;
			return () => {};
		},
	} as unknown as AgentSession;
	const service = getApplicationPort(session);
	open.push(service);
	return { service, emit: (event: unknown) => listener?.(event as AgentSessionEvent) };
}
async function snapshot(service: ApplicationService) {
	const connection = service.connect();
	const frame = (await connection[Symbol.asyncIterator]().next()).value as ApplicationFrame;
	connection.close();
	if (frame.type !== "snapshot") throw new Error(`Expected snapshot, got ${frame.type}`);
	return frame.snapshot;
}
const call = { type: "toolCall", id: "call-1", name: "lookup", arguments: {} };
const reply = (stopReason: string) => ({
	role: "assistant",
	timestamp: 1,
	stopReason,
	errorMessage: "Provider failed",
	content: [call],
});

it("shows tools of a failed model response as not run, with the shared text", async () => {
	const f = fixture();
	f.emit({ type: "message_end", message: reply("error") });
	expect((await snapshot(f.service)).tools).toEqual([
		expect.objectContaining({
			toolCallId: "call-1",
			status: "failed",
			notRun: true,
			text: "Not run: the model response failed",
		}),
	]);
});

it("keeps the abort text for tools of an aborted response and does not mark them not run", async () => {
	const f = fixture();
	f.emit({ type: "message_end", message: reply("aborted") });
	const [tool] = (await snapshot(f.service)).tools ?? [];
	expect(tool).toMatchObject({ status: "failed", text: "Operation aborted" });
	expect(tool.notRun).toBeUndefined();
});

it("does not turn a tool that already completed into not run", async () => {
	const f = fixture();
	f.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "lookup", args: {} });
	f.emit({
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "lookup",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
	});
	f.emit({ type: "message_end", message: reply("error") });
	const [tool] = (await snapshot(f.service)).tools ?? [];
	expect(tool).toMatchObject({ status: "completed", text: "ok" });
	expect(tool.notRun).toBeUndefined();
});

it("reports a failed compaction as a failed activity with its message as text", () => {
	const state = createApplicationState();
	const activities = new ApplicationActivities(new ApplicationAssets(), state);
	const activity = activities.project({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage: "Compaction failed: provider down",
	});
	expect(activity).toMatchObject({ outcome: "failed", text: "Compaction failed: provider down" });
	const ok = activities.project({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	expect(ok?.outcome).toBeUndefined();
});

it("reports a refused compaction note as a failed session activity", () => {
	const state = createApplicationState();
	const activities = new ApplicationActivities(new ApplicationAssets(), state);
	const entry = (kind: string) => ({
		type: "custom",
		id: kind,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		customType: "octocode-compaction-note",
		data: { kind, reason: `reason ${kind}` },
	});
	expect(activities.entry(entry("thrash-stop") as never)).toMatchObject({
		outcome: "failed",
		text: "reason thrash-stop",
	});
	expect(activities.entry(entry("downshift") as never)?.outcome).toBeUndefined();
});
