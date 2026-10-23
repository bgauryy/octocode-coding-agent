import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import { deferred, harness } from "./acp-test-harness.ts";

const permission: RpcExtensionUIRequest = {
	type: "extension_ui_request",
	id: "permission-1",
	method: "select",
	title: "Write /workspace/target.ts?",
	options: ["Allow once", "Allow for this session", "Deny"],
	permission: {
		toolCallId: "call-1",
		toolName: "file",
		action: "file.write",
		targets: ["/workspace/target.ts"],
		allowOnce: "Allow once",
		rejectOnce: "Deny",
	},
};

describe("ACP permission relay", () => {
	it.each(["allow_once", "reject_once"] as const)("relays only the advertised %s selection", async (kind) => {
		const h = harness({
			permission: async (request) => ({
				outcome: { outcome: "selected", optionId: request.options.find((option) => option.kind === kind)!.optionId },
			}),
		});
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].ask(permission);
		await expect.poll(() => h.workers[0].respondToExtensionUIRequest.mock.calls.length).toBe(1);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0].sessionId).toBe(sessionId);
		expect(h.requests[0].toolCall.toolCallId).toBe("call-1");
		expect(h.requests[0].options.map((option) => option.kind).sort()).toEqual(["allow_once", "reject_once"]);
		expect(h.workers[0].respondToExtensionUIRequest).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "permission-1",
			value: kind === "allow_once" ? "Allow once" : "Deny",
		});
		h.workers[0].finish();
		await run;
	});

	it.each<RequestPermissionResponse>([
		{ outcome: { outcome: "cancelled" } },
		{ outcome: { outcome: "selected", optionId: "not-advertised" } },
	])("fails closed on a cancelled or invalid client selection: %j", async (response) => {
		const h = harness({ permission: async () => response });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].ask(permission);
		await expect.poll(() => h.workers[0].respondToExtensionUIRequest.mock.calls.length).toBe(1);
		expect(h.workers[0].respondToExtensionUIRequest).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "permission-1",
			cancelled: true,
		});
		h.workers[0].finish();
		await run;
	});

	it("does not infer authorization from an ordinary dialog's labels", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].ask({
			type: "extension_ui_request",
			id: "ordinary",
			method: "select",
			title: "Choose text",
			options: ["Allow once", "Deny"],
		});
		await expect.poll(() => h.workers[0].respondToExtensionUIRequest.mock.calls.length).toBe(1);
		expect(h.requests).toHaveLength(0);
		expect(h.workers[0].respondToExtensionUIRequest).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ordinary",
			cancelled: true,
		});
		h.workers[0].finish();
		await run;
	});

	it("cancels an outstanding permission and ignores a late approval after session cancellation", async () => {
		const choice = deferred<RequestPermissionResponse>();
		const h = harness({ permission: () => choice.promise });
		await h.initialize();
		const { sessionId } = await h.newSession();
		const run = h.prompt(sessionId);
		await expect.poll(() => h.workers[0].prompt.mock.calls.length).toBe(1);
		h.workers[0].ask(permission);
		await expect.poll(() => h.requests.length).toBe(1);
		await h.cancel(sessionId);
		await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
		await expect.poll(() => h.workers[0].respondToExtensionUIRequest.mock.calls.length).toBe(1);
		const allow = h.requests[0].options.find((option) => option.kind === "allow_once")!;
		choice.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
		// A subsequent request provides a protocol barrier after the client's late response.
		await h.newSession();
		expect(h.workers[0].respondToExtensionUIRequest.mock.calls).toEqual([
			[{ type: "extension_ui_response", id: "permission-1", cancelled: true }],
		]);
	});
});
