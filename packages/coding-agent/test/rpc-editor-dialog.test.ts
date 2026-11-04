import { describe, expect, it } from "vitest";
import { UIPromptTracker } from "../src/core/features/runner/ui-prompt.ts";
import { showExtensionEditor } from "../src/modes/interactive/interactive-mode/extension-dialogs.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "../src/modes/rpc/rpc-mode/ui-context.ts";

function context() {
	const records: Array<Record<string, unknown>> = [];
	const pending: PendingExtensionRequests = new Map();
	return { records, pending, ui: createExtensionUIContext((record) => void records.push(record as never), pending) };
}

describe("the RPC editor dialog", () => {
	it("closes on abort like the other dialogs: no value, a dismiss record, no pending request", async () => {
		const { ui, records, pending } = context();
		const controller = new AbortController();
		const editing = ui.editor("Edit", "text", { signal: controller.signal });
		expect(records[0]).toMatchObject({
			type: "extension_ui_request",
			method: "editor",
			title: "Edit",
			prefill: "text",
		});
		controller.abort();
		await expect(editing).resolves.toBeUndefined();
		expect(records[1]).toEqual({ type: "extension_ui_dismiss", id: records[0]?.id });
		expect(pending.size).toBe(0);
	});

	it("takes the host's answer", async () => {
		const { ui, records, pending } = context();
		const editing = ui.editor("Edit");
		pending.get(records[0]?.id as string)?.resolve({ type: "extension_ui_response", id: "x", value: "edited" });
		await expect(editing).resolves.toBe("edited");
	});

	it("receives the caller's abort through the prompt tracker", async () => {
		const { ui, records } = context();
		const tracked = new UIPromptTracker(async () => undefined).wrap(ui);
		const controller = new AbortController();
		const editing = tracked.editor("Edit", undefined, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(records[0]).toMatchObject({ method: "editor" });
		controller.abort();
		await expect(editing).resolves.toBeUndefined();
	});
});

describe("the terminal editor dialog", () => {
	it("does not open once its signal has aborted", async () => {
		await expect(
			showExtensionEditor({} as never, "Edit", undefined, { signal: AbortSignal.abort() }),
		).resolves.toBeUndefined();
	});
});
