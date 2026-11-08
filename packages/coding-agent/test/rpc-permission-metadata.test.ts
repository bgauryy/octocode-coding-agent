import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/features/types.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "../src/modes/rpc/rpc-mode/ui-context.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import { askReview } from "../src/octocode/files/review.ts";
import { externalPermissionDialog } from "../src/octocode/external/permission-dialog.ts";
import { selectAnswer } from "../src/octocode/permission/ask/text.ts";

function fixture() {
	const pending: PendingExtensionRequests = new Map();
	const requests: RpcExtensionUIRequest[] = [];
	const ui = createExtensionUIContext((value) => {
		if ("type" in value && value.type === "extension_ui_request") requests.push(value);
	}, pending);
	const select = () => {
		const request = requests.at(-1);
		if (request?.method !== "select") throw new Error("Expected select request");
		return request;
	};
	/** The question reaches the host after the dialog lock is taken, so a request shows up a few ticks after the ask. */
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	const reply = (value: string) => {
		const request = select();
		const entry = pending.get(request.id);
		if (!entry) throw new Error("Missing pending request");
		entry.resolve({ type: "extension_ui_response", id: request.id, value });
	};
	return { ctx: { hasUI: true, ui }, pending, requests, select, settle, reply };
}

describe("permission metadata over RPC UI", () => {
	it.each([
		["Allow once", "once"],
		["Deny", "deny"],
		["invented approval", undefined],
	] as const)("preserves the existing decision for %s", async (choice, expected) => {
		const f = fixture();
		const answer = selectAnswer(
			f.ctx,
			{
				title: "Run command?",
				what: ["git status --short"],
				action: "shell",
				toolCallId: "fallback",
				invocation: { active: true, toolName: "bash", toolCallId: "call-1", input: { command: "git status --short" } },
			},
			"manual",
			false,
			"",
		);
		await f.settle();
		const request = f.select();
		expect(request.permission).toEqual({
			toolCallId: "call-1",
			toolName: "bash",
			action: "shell",
			targets: ["git status --short"],
			allowOnce: "Allow once",
			rejectOnce: "Deny",
		});
		expect(request.options).toContain(request.permission?.allowOnce);
		expect(request.options).toContain(request.permission?.rejectOnce);
		f.reply(choice);
		await expect(answer).resolves.toBe(expected);
		expect(f.pending.size).toBe(0);
	});

	it("does not turn generic selectors or confirmations into permission requests", async () => {
		const f = fixture();
		const generic = f.ctx.ui.select("Choose a template", ["Allow once", "Deny"]);
		expect(f.select()).not.toHaveProperty("permission");
		f.reply("Deny");
		await generic;
		const confirmation = f.ctx.ui.confirm("Continue?", "Choose whether to continue");
		const request = f.requests.at(-1)!;
		expect(request.method).toBe("confirm");
		expect(request).not.toHaveProperty("permission");
		f.pending.get(request.id)!.resolve({ type: "extension_ui_response", id: request.id, confirmed: false });
		await expect(confirmation).resolves.toBe(false);
	});

	it("cancels an outstanding permission select when its policy signal is revoked", async () => {
		const f = fixture();
		const controller = new AbortController();
		const answer = selectAnswer(
			f.ctx,
			{ title: "Run?", what: ["command"], action: "shell", signal: controller.signal },
			"manual",
			false,
			"",
		);
		await f.settle();
		expect(f.select().permission).toBeDefined();
		controller.abort();
		await expect(answer).resolves.toBeUndefined();
		expect(f.pending.size).toBe(0);
	});

	it("keeps whole-batch file approval distinct from subsequent per-file decisions", async () => {
		const f = fixture();
		const review = askReview(
			f.ctx,
			[
				{ type: "write", path: "new.ts", reason: "Add source", content: "export {};" },
				{ type: "edit", path: "old.ts", movePath: "moved.ts", reason: "Move source" },
			],
			undefined,
			[],
			{ toolCallId: "file-1", toolName: "file" },
		);
		await f.settle();
		expect(f.select().permission).toEqual({
			toolCallId: "file-1",
			toolName: "file",
			action: "file.workspace",
			targets: ["write new.ts", "edit old.ts → moved.ts"],
			allowOnce: "Apply all",
			rejectOnce: "Reject all",
		});
		f.reply("Review one by one");
		await f.settle();
		expect(f.select().permission).toMatchObject({
			targets: ["write new.ts"],
			allowOnce: "Apply",
			rejectOnce: "Reject",
		});
		f.reply("Apply");
		await f.settle();
		expect(f.select().permission?.targets).toEqual(["edit old.ts → moved.ts"]);
		f.reply("Reject");
		await expect(review).resolves.toEqual(new Map([[1, undefined]]));
	});

	it("maps nested external approvals back to the advertised single-use option identity", async () => {
		const f = fixture();
		const decision = externalPermissionDialog(f.ctx as ExtensionContext)(
			{
				sessionId: "external-session",
				toolCall: { toolCallId: "external-call", title: "Run external task" },
				options: [
					{ optionId: "forever", name: "Always", kind: "allow_always" },
					{ optionId: "one", name: "Proceed", kind: "allow_once" },
					{ optionId: "no", name: "Stop", kind: "reject_once" },
				],
			},
			new AbortController().signal,
		);
		await f.settle();
		const request = f.select();
		expect(request.options).toEqual(["Proceed", "Stop"]);
		expect(request.permission).toMatchObject({
			toolCallId: "external-call",
			toolName: "external",
			allowOnce: "Proceed",
			rejectOnce: "Stop",
		});
		f.reply(request.permission!.allowOnce);
		await expect(decision).resolves.toEqual({ outcome: { outcome: "selected", optionId: "one" } });
	});
});
