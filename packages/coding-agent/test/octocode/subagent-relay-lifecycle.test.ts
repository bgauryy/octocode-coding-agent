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

/** A relay whose parent UI never answers its select, confirm or input (and ignores the abort). */
function silentRelay(askTimeoutMs: number) {
	const sent: Record<string, unknown>[] = [];
	const never = () => new Promise<never>(() => {});
	const relay = new ChildRelay(
		{ id: "capped-child" },
		{
			permission: { allows: () => false, relayedAllow: vi.fn(), adopt: vi.fn(), relayNote: vi.fn() },
			ui: { select: never, confirm: never, input: never, notify: vi.fn() },
		},
		{ nonce: "", send: (response) => sent.push(response), askTimeoutMs },
	);
	return { relay, sent };
}

it.each([
	["select with no child timeout", { method: "select", options: ["Yes"] }],
	["select with a child timeout above the cap", { method: "select", options: ["Yes"], timeout: 3_600_000 }],
	["confirm", { method: "confirm", message: "Sure?", timeout: 3_600_000 }],
	["input", { method: "input", timeout: 3_600_000 }],
])("closes a relayed %s at the relay cap", async (_name, extra) => {
	vi.useFakeTimers();
	try {
		const { relay, sent } = silentRelay(1_000);
		relay.handle({ type: "extension_ui_request", id: "d1", title: "Continue?", ...extra });
		await vi.advanceTimersByTimeAsync(999);
		expect(sent).toEqual([]);
		expect(relay.open).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toEqual([{ type: "extension_ui_response", id: "d1", cancelled: true }]);
		expect(relay.open).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

it("closes a dialog at the child's timeout when it is shorter than the cap", async () => {
	vi.useFakeTimers();
	try {
		const { relay, sent } = silentRelay(60_000);
		relay.handle({
			type: "extension_ui_request",
			id: "d2",
			method: "select",
			title: "?",
			options: ["Yes"],
			timeout: 500,
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(sent).toEqual([{ type: "extension_ui_response", id: "d2", cancelled: true }]);
	} finally {
		vi.useRealTimers();
	}
});
