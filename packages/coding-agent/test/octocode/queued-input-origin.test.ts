import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inputOrigin, withInputOrigin, type InputOrigin } from "../../src/core/input-origin.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { fakeCtx, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A queued steer or follow-up keeps the origin it was sent under, and the turn it starts runs under it (B95). */

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A session whose first turn waits in a tool, so input can be queued into the running run, and whose next turn asks to
 * widen the permission mode through the real permission owner, as the model's tool call would.
 */
async function scenario(options: { hasUI: boolean; answer: boolean; mode: "steer" | "followUp" }) {
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const permission = fakePermission("manual");
	const ctx = fakeCtx({ cwd: tmp(), hasUI: options.hasUI });
	const confirm = vi.fn(async () => options.answer);
	ctx.ui.confirm = confirm;
	const seen: InputOrigin[] = [];
	const results: boolean[] = [];
	const wait: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const widen: AgentTool = {
		name: "widen",
		label: "Widen",
		description: "Ask for the full permission mode",
		parameters: Type.Object({}),
		execute: async () => {
			seen.push(inputOrigin());
			results.push(await permission.chooseMode("full", ctx));
			return { content: [{ type: "text", text: "asked" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [wait, widen] });
	harnesses.push(harness);
	// A steer is read at the next request; a follow-up only once the model would otherwise stop.
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		...(options.mode === "followUp" ? [fauxAssistantMessage("finished")] : []),
		fauxAssistantMessage(fauxToolCall("widen", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const started = new Promise<void>((resolve) => {
		const stop = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				stop();
				resolve();
			}
		});
	});
	/** Starts the run under `starter`, queues `input` under `sender` while it waits, and lets the run finish. */
	async function run(starter: InputOrigin, sender: InputOrigin) {
		const prompt = withInputOrigin(starter, () => harness.session.prompt("start"));
		await started;
		await flush();
		await withInputOrigin(sender, () => harness.session[options.mode]("change course"));
		release();
		await prompt;
	}
	return { permission, confirm, seen, results, run };
}

describe.each(["steer", "followUp"] as const)("a %s queued into a run another origin started", (mode) => {
	it.each(["web", "acp"] as const)(
		"from %s into a terminal-started run asks that client's dialog for a permission widen",
		async (client) => {
			const s = await scenario({ hasUI: true, answer: true, mode });
			await s.run("terminal", client);
			expect(s.seen).toEqual([client]);
			expect(s.confirm).toHaveBeenCalledTimes(1);
			expect(s.results).toEqual([true]);
			expect(s.permission.mode).toBe("full");
		},
	);

	it.each(["web", "acp"] as const)("from %s is refused when the client declines", async (client) => {
		const s = await scenario({ hasUI: true, answer: false, mode });
		await s.run("terminal", client);
		expect(s.confirm).toHaveBeenCalledTimes(1);
		expect(s.results).toEqual([false]);
		expect(s.permission.mode).toBe("manual");
	});

	it.each(["web", "acp"] as const)("from %s is refused when the client has no dialog", async (client) => {
		const s = await scenario({ hasUI: false, answer: true, mode });
		await s.run("terminal", client);
		expect(s.confirm).not.toHaveBeenCalled();
		expect(s.results).toEqual([false]);
		expect(s.permission.mode).toBe("manual");
	});

	it.each(["web", "acp"] as const)(
		"from the terminal into a %s-started run keeps terminal authority",
		async (client) => {
			const s = await scenario({ hasUI: true, answer: false, mode });
			await s.run(client, "terminal");
			expect(s.seen).toEqual(["terminal"]);
			expect(s.confirm).not.toHaveBeenCalled();
			expect(s.permission.mode).toBe("full");
		},
	);

	it("from the terminal into a terminal-started run is unchanged", async () => {
		const s = await scenario({ hasUI: true, answer: false, mode });
		await s.run("terminal", "terminal");
		expect(s.seen).toEqual(["terminal"]);
		expect(s.confirm).not.toHaveBeenCalled();
		expect(s.permission.mode).toBe("full");
	});
});
