import type { AgentContext, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { AcpSession } from "../../acp/src/server/session.ts";
import { assistant, FakeWorker } from "../../acp/test/server/acp-test-harness.ts";

it("holds startup output and permission requests for replay, uses canonical identity, and cancels late approval", async () => {
	const worker = new FakeWorker();
	const state = await worker.getState();
	const choice = Promise.withResolvers<RequestPermissionResponse>();
	const notify = vi.fn(async (_method: unknown, _params: unknown) => {});
	const request = vi.fn((_method: unknown, _params: unknown) => choice.promise);
	const session = new AcpSession("provisional", worker, { notify, request } as unknown as AgentContext, 1000);
	worker.start.mockImplementationOnce(async () => {
		worker.identify(state.sessionId);
		worker.emit({ type: "session_dispatch", active: true, dispatchId: "startup" });
		worker.emit({ type: "message_end", message: assistant("startup message") });
		worker.ask({
			type: "extension_ui_request",
			id: "permission",
			method: "select",
			title: "Write?",
			options: ["Allow", "Deny"],
			permission: {
				toolName: "file",
				action: "file.write",
				targets: ["/workspace/file"],
				allowOnce: "Allow",
				rejectOnce: "Deny",
			},
		});
	});
	worker.abort.mockImplementationOnce(async () => {
		worker.emit({ type: "session_dispatch", active: false, dispatchId: "startup" });
	});
	try {
		const replay = Promise.withResolvers<void>();
		const starting = session.start(undefined, () => replay.promise);
		await Promise.resolve();
		expect(notify).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		replay.resolve();
		await expect(starting).resolves.toBe(state.sessionId);
		await expect.poll(() => request.mock.calls.length).toBe(1);
		expect(notify.mock.calls[0][1]).toMatchObject({ sessionId: state.sessionId });
		expect(request.mock.calls[0][1]).toMatchObject({ sessionId: state.sessionId });
		await session.cancel();
		choice.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
		await expect.poll(() => worker.respondToExtensionUIRequest.mock.calls.length).toBe(1);
		expect(worker.respondToExtensionUIRequest).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "permission",
			cancelled: true,
		});
		expect(worker.stop).not.toHaveBeenCalled();
	} finally {
		choice.resolve({ outcome: { outcome: "cancelled" } });
		await session.close();
	}
});
