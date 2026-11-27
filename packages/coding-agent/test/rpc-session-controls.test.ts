import { expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createSessionControls } from "../src/modes/rpc/rpc-mode/session-controls.ts";

it("preserves ordinary RPC extension session controls and their arguments", async () => {
	const runtime = {
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false, selectedText: "selected" })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
	};
	const controls = createSessionControls(runtime as unknown as AgentSessionRuntime, false);
	const withSession = vi.fn(async () => {});
	await expect(controls.newSession({ parentSession: "/parent" })).resolves.toEqual({ cancelled: false });
	await expect(controls.fork("entry", { position: "at" })).resolves.toEqual({ cancelled: false });
	await expect(controls.switchSession("/saved", { withSession })).resolves.toEqual({ cancelled: false });
	expect(runtime.newSession).toHaveBeenCalledWith({ parentSession: "/parent" });
	expect(runtime.fork).toHaveBeenCalledWith("entry", { position: "at" });
	expect(runtime.switchSession).toHaveBeenCalledWith("/saved", { withSession });
});

it("refuses ACP extension session selection before invoking any runtime mutation", async () => {
	const runtime = { newSession: vi.fn(), fork: vi.fn(), switchSession: vi.fn() };
	const controls = createSessionControls(runtime as unknown as AgentSessionRuntime, true);
	await expect(controls.newSession()).rejects.toThrow("ACP owns session selection");
	await expect(controls.fork("entry")).rejects.toThrow("ACP owns session selection");
	await expect(controls.switchSession("/saved")).rejects.toThrow("ACP owns session selection");
	expect(runtime.newSession).not.toHaveBeenCalled();
	expect(runtime.fork).not.toHaveBeenCalled();
	expect(runtime.switchSession).not.toHaveBeenCalled();
});
