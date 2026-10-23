import { expect, it, vi } from "vitest";
import { ChildRelay } from "../../src/octocode/subagents/relay.ts";

it("cancels a dialog from the child's final buffered event when the relay ends", async () => {
	const sent: Record<string, unknown>[] = [];
	const waiting: boolean[] = [];
	let dialogSignal: AbortSignal | undefined;
	const relay = new ChildRelay(
		{ id: "finished-child" },
		{
			permission: { allows: () => false, relayedAllow: vi.fn(), adopt: vi.fn(), relayNote: vi.fn() },
			ui: {
				select: async (_title, _options, options) => {
					dialogSignal = options?.signal;
					return new Promise<undefined>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
					});
				},
				confirm: async () => false,
				input: async () => undefined,
				notify: vi.fn(),
			},
		},
		{ nonce: "", send: (response) => sent.push(response), onWaiting: (value) => waiting.push(value) },
	);
	// Process cleanup runs before the last unterminated stdout frame is parsed.
	relay.cancelAll();
	relay.handle({ type: "extension_ui_request", method: "select", id: "last", title: "Continue?", options: ["Yes"] });
	await vi.waitFor(() => expect(dialogSignal).toBeDefined());
	try {
		relay.end();
		expect(relay.open).toBe(0);
		expect(dialogSignal?.aborted).toBe(true);
		await Promise.resolve();
		expect(sent).toEqual([{ type: "extension_ui_response", id: "last", cancelled: true }]);
		expect(waiting).toEqual([true, false]);
	} finally {
		relay.cancelAll();
	}
});
