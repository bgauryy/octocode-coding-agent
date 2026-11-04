import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import { hasSessionDispatch } from "../src/core/agent-session/dispatch.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { handlePrompt } from "../src/modes/rpc/rpc-mode/prompt.ts";
import { createHarness, getAssistantTexts } from "./suite/harness.ts";

it("correlates nested extension sends through asynchronous preflight while preserving handled disposition", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [
			(api) => {
				api.registerCommand("outer", {
					handler: async () => {
						api.sendUserMessage("/inner", { expandPromptTemplates: true });
					},
				});
				api.registerCommand("inner", {
					handler: async () => {
						api.sendUserMessage("generated");
					},
				});
				api.on("input", async (event) => {
					if (event.text === "generated") {
						entered.resolve();
						await release.promise;
					}
				});
			},
		],
	});
	const responses: object[] = [];
	const activity: unknown[] = [];
	try {
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("nested answer")]);
		h.session.subscribe((event) => {
			if (event.type === "session_dispatch") activity.push(event);
		});
		handlePrompt(
			h.session,
			{ id: "request", type: "prompt", message: "/outer", waitForCompletion: true, dispatchId: "owned" },
			(value) => responses.push(value),
		);
		await entered.promise;
		expect(responses).toEqual([]);
		expect(hasSessionDispatch(h.session)).toBe(true);
		release.resolve();
		await vi.waitFor(() =>
			expect(responses).toEqual([
				{
					id: "request",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "handled", outcome: expect.objectContaining({ status: "completed" }) },
				},
			]),
		);
		expect(getAssistantTexts(h)).toEqual(["nested answer"]);
		expect(activity).toEqual([
			{ type: "session_dispatch", active: true, dispatchId: "owned" },
			{ type: "session_dispatch", active: false, dispatchId: "owned" },
		]);
		expect(hasSessionDispatch(h.session)).toBe(false);
	} finally {
		release.resolve();
		h.cleanup();
	}
});

it("completes a handled command without model work", async () => {
	const h = await createHarness({
		extensionFactories: [
			(api) => {
				api.registerCommand("nothing", { handler: async () => {} });
			},
		],
	});
	const responses: object[] = [];
	try {
		await h.session.bindExtensions({});
		handlePrompt(h.session, { type: "prompt", message: "/nothing", waitForCompletion: true }, (value) =>
			responses.push(value),
		);
		await vi.waitFor(() =>
			expect(responses).toEqual([
				{ id: undefined, type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
			]),
		);
		expect(h.events.some((event) => event.type === "agent_start")).toBe(false);
	} finally {
		h.cleanup();
	}
});

it("keeps a dispatch active through a deferred agent_settled follow-up", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let sent = false;
	const h = await createHarness({
		extensionFactories: [
			(api) => {
				api.on("agent_settled", () => {
					if (!sent) {
						sent = true;
						api.sendUserMessage("follow-up");
					}
				});
				api.on("input", async (event) => {
					if (event.text === "follow-up") {
						entered.resolve();
						await release.promise;
					}
				});
			},
		],
	});
	const responses: object[] = [];
	const activity: unknown[] = [];
	try {
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("follow-up answer")]);
		h.session.subscribe((event) => {
			if (event.type === "session_dispatch") activity.push(event);
		});
		handlePrompt(
			h.session,
			{ type: "prompt", message: "first", waitForCompletion: true, dispatchId: "deferred" },
			(value) => responses.push(value),
		);
		await entered.promise;
		expect(getAssistantTexts(h)).toEqual(["first answer"]);
		expect(responses).toEqual([]);
		expect(activity).toEqual([{ type: "session_dispatch", active: true, dispatchId: "deferred" }]);
		release.resolve();
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(getAssistantTexts(h)).toEqual(["first answer", "follow-up answer"]);
		expect(activity).toEqual([
			{ type: "session_dispatch", active: true, dispatchId: "deferred" },
			{ type: "session_dispatch", active: false, dispatchId: "deferred" },
		]);
	} finally {
		release.resolve();
		h.cleanup();
	}
});

it("reports a nested send's preflight rejection even when the extension API consumes its promise", async () => {
	const h = await createHarness({
		extensionFactories: [
			(api) => {
				api.registerCommand("send", {
					handler: async () => {
						api.sendUserMessage("generated");
					},
				});
			},
		],
	});
	const responses: object[] = [];
	try {
		await h.session.bindExtensions({});
		vi.spyOn(h.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		vi.spyOn(h.session.modelRuntime, "checkAuth").mockResolvedValue(undefined);
		handlePrompt(h.session, { type: "prompt", message: "/send", waitForCompletion: true }, (value) =>
			responses.push(value),
		);
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(responses[0]).toMatchObject({ success: false, error: expect.stringContaining("No API key") });
		expect(hasSessionDispatch(h.session)).toBe(false);
	} finally {
		h.cleanup();
	}
});

it("cancels pending preflight before it can start a model run and preserves the next dispatch", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		extensionFactories: [
			(api) => {
				api.on("input", async (event) => {
					if (event.text === "hold") {
						entered.resolve();
						await release.promise;
					}
				});
			},
		],
	});
	const responses: object[] = [];
	try {
		await h.session.bindExtensions({});
		handlePrompt(h.session, { type: "prompt", message: "hold", waitForCompletion: true }, (value) =>
			responses.push(value),
		);
		await entered.promise;
		await h.session.abort();
		release.resolve();
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(responses[0]).toMatchObject({ success: false, error: "Prompt dispatch cancelled" });
		expect(h.events.some((event) => event.type === "agent_start")).toBe(false);
		h.setResponses([fauxAssistantMessage("next answer")]);
		handlePrompt(h.session, { type: "prompt", message: "next", waitForCompletion: true }, (value) =>
			responses.push(value),
		);
		await vi.waitFor(() => expect(responses).toHaveLength(2));
		expect(responses[1] as RpcResponse).toMatchObject({ success: true, data: { disposition: "started" } });
		expect(getAssistantTexts(h)).toEqual(["next answer"]);
	} finally {
		release.resolve();
		h.cleanup();
	}
});
