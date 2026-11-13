import { describe, expect, it, vi } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ToolDisplayFunction } from "../src/core/features/types/tools.ts";

function fixture(messages: unknown[] = [], display?: ToolDisplayFunction) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "projection-test",
		messages,
		isStreaming: false,
		getToolRenderers: display ? () => ({ display }) : undefined,
		subscribe(fn: typeof listener) {
			listener = fn;
			return () => {};
		},
	} as unknown as AgentSession;
	const service = getApplicationPort(session);
	return {
		service,
		emit(event: unknown) {
			listener?.(event as AgentSessionEvent);
		},
	};
}
const result = { content: [{ type: "text", text: "RAW_PAYLOAD" }], details: { structured: { status: "valid" } } };
async function snapshot(service: ReturnType<typeof getApplicationPort>) {
	const connection = service.connect();
	const frame = (await connection[Symbol.asyncIterator]().next()).value;
	connection.close();
	return frame.snapshot;
}
describe("application output projection", () => {
	it("keeps projected output authoritative for registered displays and runs the projector once per tool update", () => {
		const display = vi.fn<ToolDisplayFunction>(({ args, result }) => ({
			title: "Custom",
			summary: args.goal,
			reason: args.reason,
			kind: "agent",
			preface: [{ type: "markdown", text: args.task ?? "" }],
			state: "waiting",
			locations: [{ path: "result-derived-link" }],
			outcome: { text: "result-derived-outcome" },
			blocks: [{ type: "text", text: JSON.stringify(result ?? {}) }],
		}));
		const project = vi.fn((owner: string) => (owner === "agent" ? "Projected report" : undefined));
		const f = fixture([], display);
		f.service.setToolOutputProjector(project);
		f.emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "agent",
			args: { goal: "Check architecture", reason: "Support future interfaces", task: "Inspect the application" },
		});
		display.mockClear();
		for (const type of ["tool_execution_update", "tool_execution_end"]) {
			f.emit({ type, toolCallId: "a", toolName: "agent", result, partialResult: result });
			const tool = f.service.getSnapshot().tools?.[0];
			if (!tool) throw new Error("Expected the projected tool snapshot");
			expect(tool?.display?.blocks).toEqual([
				{ type: "text", text: "Projected report", ...(type === "tool_execution_update" ? { preview: "tail" } : {}) },
			]);
			expect(tool.display).toMatchObject({
				title: "Custom",
				summary: "Check architecture",
				reason: "Support future interfaces",
				kind: "agent",
				preface: [{ type: "markdown", text: "Inspect the application" }],
			});
			expect(tool.display?.state).toBeUndefined();
			expect(tool.display?.locations).toBeUndefined();
			expect(JSON.stringify(tool.display)).not.toContain("result-derived");
		}
		expect(project).toHaveBeenCalledTimes(2);
		expect(display).toHaveBeenCalledTimes(2);
		for (const [input] of display.mock.calls) expect(input.result).toBeUndefined();
		f.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result });
		expect(display).toHaveBeenCalledTimes(3);
		expect(display.mock.lastCall?.[0].result).toBe(result);
		expect(f.service.getSnapshot().tools?.[1]?.display?.title).toBe("Custom");
		expect(result.content[0].text).toBe("RAW_PAYLOAD");
		f.service.dispose();
	});

	it("does not expose raw output to registered displays when the projector fails", () => {
		const display = vi.fn<ToolDisplayFunction>(() => ({ title: "Custom", blocks: [] }));
		const f = fixture([], display);
		f.service.setToolOutputProjector(() => {
			throw new Error("RAW_PAYLOAD");
		});
		f.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "agent", result });
		const tool = f.service.getSnapshot().tools?.[0];
		expect(tool?.display?.blocks).toEqual([{ type: "text", text: "Tool output unavailable" }]);
		expect(display).toHaveBeenCalledOnce();
		expect(display.mock.lastCall?.[0].result).toBeUndefined();
		f.service.dispose();
	});

	it("reprojects custom displays and restores them when the projection is removed", () => {
		const display = vi.fn<ToolDisplayFunction>(() => ({
			title: "Custom",
			blocks: [{ type: "text", text: "RAW_PAYLOAD" }],
		}));
		const f = fixture([], display);
		f.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "agent", result });
		expect(f.service.getSnapshot().tools?.[0]?.display?.title).toBe("Custom");
		const remove = f.service.setToolOutputProjector(() => "Projected report");
		expect(f.service.getSnapshot().tools?.[0]?.display?.blocks).toEqual([{ type: "text", text: "Projected report" }]);
		expect(display).toHaveBeenCalledTimes(2);
		remove();
		expect(f.service.getSnapshot().tools?.[0]?.display?.title).toBe("Custom");
		expect(display).toHaveBeenCalledTimes(3);
		f.service.dispose();
	});

	it("projects tool updates, completion and message copies without changing native results", async () => {
		const f = fixture();
		f.service.setToolOutputProjector((owner, value) =>
			owner === "agent" || owner === "octocode-agent-result"
				? `safe:${Boolean((value as typeof result).details)}`
				: undefined,
		);
		for (const type of ["tool_execution_update", "tool_execution_end"]) {
			f.emit({ type, toolCallId: "a", toolName: "agent", result, partialResult: result });
			expect((await snapshot(f.service)).tools[0].text).toBe("safe:true");
		}
		f.emit({ type: "message_end", message: { role: "toolResult", toolName: "agent", ...result } });
		f.emit({ type: "message_end", message: { role: "custom", customType: "octocode-agent-result", ...result } });
		f.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "b", result });
		const state = await snapshot(f.service);
		expect(state.messages.map((message: { text: string }) => message.text)).toEqual(["safe:true", "safe:true"]);
		expect(state.tools[1].text).toBe("RAW_PAYLOAD");
		expect(result.content[0].text).toBe("RAW_PAYLOAD");
		f.service.dispose();
	});
	it("reprojects history and clears queued raw frames while preserving active tool identity and order", async () => {
		const f = fixture([{ role: "custom", customType: "octocode-agent-result", ...result }]);
		f.emit({ type: "tool_execution_update", toolCallId: "a", toolName: "agent", partialResult: result });
		const before = await snapshot(f.service);
		const connection = f.service.connect();
		const iterator = connection[Symbol.asyncIterator]();
		f.service.setToolOutputProjector(() => "safe");
		expect((await iterator.next()).value.type).toBe("resync");
		const after = await snapshot(f.service);
		expect(after.tools[0]).toEqual({
			...before.tools[0],
			text: "safe",
			content: [{ id: "tool:a:0", type: "text", text: "safe" }],
			full: expect.objectContaining({ mimeType: "application/json" }),
			// The display follows the projection: the raw output never reaches it.
			display: { title: "agent", blocks: [{ type: "text", text: "safe", preview: "tail" }] },
		});
		expect(after.messages[0]).toEqual({
			...before.messages[0],
			text: "safe",
			content: [{ id: `${before.messages[0].id}:0`, type: "text", text: "safe" }],
			full: expect.objectContaining({ mimeType: "application/json" }),
		});
		expect(f.service.readAsset(after.messages[0].full.id)?.data).toContain("RAW_PAYLOAD");
		expect(f.service.readAsset(after.tools[0].full.id)?.data).toContain("RAW_PAYLOAD");
		expect(JSON.stringify(after)).not.toContain("RAW_PAYLOAD");
		connection.close();
		f.service.dispose();
	});
	it("restores the still-active previous projector", async () => {
		const f = fixture();
		const old = f.service.setToolOutputProjector(() => "old");
		const current = f.service.setToolOutputProjector(() => "current");
		current();
		f.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "agent", result });
		expect((await snapshot(f.service)).tools[0].text).toBe("old");
		old();
		f.service.dispose();
	});

	it("fails closed and does not resurrect an unsubscribed projector", async () => {
		const f = fixture();
		const old = f.service.setToolOutputProjector(() => "old");
		const current = f.service.setToolOutputProjector(() => {
			throw new Error("RAW_PAYLOAD");
		});
		old();
		f.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "agent", result });
		expect((await snapshot(f.service)).tools[0].text).toBe("Tool output unavailable");
		current();
		f.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "agent", result });
		expect((await snapshot(f.service)).tools[0].text).toBe("RAW_PAYLOAD");
		f.service.dispose();
	});
});
