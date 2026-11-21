import { expect, it, vi } from "vitest";
import type { ApplicationService } from "../../src/core/application/index.ts";
import { applicationRenderer } from "../../src/modes/interactive/interactive-mode/application-events.ts";

/** The live ingress honors the shared visibility rule the web feed uses (`applicationMessageDisplayed`). */
it("draws no row for a message the host marked display:false", () => {
	const addChild = vi.fn();
	const host = { pendingTools: new Map(), chatContainer: { addChild }, ui: { requestRender: vi.fn() } };
	const port = { readAsset: vi.fn() } as unknown as ApplicationService;
	const render = applicationRenderer(host as never, port);
	for (const role of ["user", "assistant"] as const)
		render({
			type: "message.completed",
			message: { id: `hidden-${role}`, role, complete: true, text: "context only", display: false },
		} as never);
	expect(addChild).not.toHaveBeenCalled();
});
