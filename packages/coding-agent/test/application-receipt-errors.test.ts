import { Container } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

function session(id: string): AgentSession {
	return {
		sessionId: id,
		messages: [],
		isStreaming: false,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		subscribe: () => () => {},
		async prompt() {},
		async abort() {},
	} as unknown as AgentSession;
}

/** A receipt store whose database fails when it records the outcome. */
const failingStore = {
	begin: (command: { id: string }) => ({ fresh: true, receipt: { id: command.id, status: "accepted" as const } }),
	finish: () => {
		throw new Error(`database is locked (${SECRET})`);
	},
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("application receipt persistence failures", () => {
	afterEach(() => vi.restoreAllMocks());

	test("go to the subscribers' error handler, redacted and once, instead of over the terminal", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const service = getApplicationPort(session("receipt-handler"));
		service.setReceiptStore(failingStore);
		const reported: string[] = [];
		const onError = (error: unknown) => reported.push((error as Error).message);
		// A terminal subscribes to both streams with one handler.
		service.subscribe(() => {}, onError);
		service.subscribeNative(() => {}, onError);
		const receipts: string[] = [];
		service.subscribe((event) => {
			if (event.type === "command.receipt") receipts.push(`${event.receipt.status}:${event.receipt.message ?? ""}`);
		});

		await service.execute({ id: "c1", sessionId: "receipt-handler", action: "prompt", text: "hi" });
		await settle();

		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("Command outcome could not be saved: database is locked");
		expect(reported[0]).not.toContain(SECRET);
		expect(stderr).not.toHaveBeenCalled();
		// The failed receipt is still published.
		expect(receipts.at(-1)).toMatch(/^failed:Command outcome could not be persisted/);
		service.dispose();
	});

	test("interactive mode shows the failure as it is, not as a display failure", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const agentSession = session("receipt-interactive");
		const showError = vi.fn();
		const host = createFakeHost({
			session: agentSession,
			showError,
			handleEvent: async () => {},
			uiStore: createUiStore(),
			pendingMessagesContainer: new Container(),
			ui: { requestRender: () => {} },
		});
		subscribeToAgent(host);
		const service = getApplicationPort(agentSession);
		service.setReceiptStore(failingStore);

		await service.execute({ id: "c3", sessionId: "receipt-interactive", action: "prompt", text: "hi" });
		await settle();

		expect(showError).toHaveBeenCalledExactlyOnceWith(
			expect.stringMatching(/^Command outcome could not be saved: database is locked/),
		);
		expect(stderr).not.toHaveBeenCalled();
		host.unsubscribe?.();
		service.dispose();
	});

	test("fall back to stderr once when no subscriber has a handler", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		const service = getApplicationPort(session("receipt-stderr"));
		service.setReceiptStore(failingStore);
		service.subscribe(() => {});

		await service.execute({ id: "c2", sessionId: "receipt-stderr", action: "prompt", text: "hi" });
		await settle();

		expect(stderr).toHaveBeenCalledTimes(1);
		expect(String(stderr.mock.calls[0]?.[0])).toContain("Command outcome could not be saved");
		service.dispose();
	});
});
