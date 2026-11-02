import { expect, it, vi } from "vitest";
import type { ApplicationService } from "../../src/core/application/index.ts";
import { applicationRenderer } from "../../src/modes/interactive/interactive-mode/application-events.ts";

/** A call a tool makes while it runs (the `file` tool's parse check) is the parent's work, not a row of its own. */
it("draws no row for a nested tool call, its progress or its failure", () => {
	const addChild = vi.fn();
	const host = { pendingTools: new Map(), chatContainer: { addChild }, ui: { requestRender: vi.fn() } };
	const render = applicationRenderer(host as never, { readAsset: vi.fn() } as unknown as ApplicationService);
	const nested = { toolCallId: "call-1/1", toolName: "mcp__octocode__astSearch", parentToolCallId: "call-1" };
	render({ type: "tool.started", ...nested, arguments: { queries: [{ path: "notes.md" }] } } as never);
	render({ type: "tool.completed", ...nested, failed: true } as never);
	expect(host.pendingTools.size).toBe(0);
	expect(addChild).not.toHaveBeenCalled();
});
