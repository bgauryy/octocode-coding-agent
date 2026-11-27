import { expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A decision's audit note can carry text a PermissionRequest hook chose (its denial message). Like every other audit
 * field it is one line, free of terminal controls, secrets redacted and clipped (per part, as `what` is), so a hook
 * cannot flood the log.
 */
it("folds, sanitizes and clips a hook's denial message in the audit note", async () => {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "manual" }, isSubagent: false });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	permission.start(ctx);
	const message = `blocked by policy\n\u001b[31mred\u001b[0m ${"x".repeat(5000)}`;
	permission.setResolver(async () => ({ decision: "deny", message }));
	const verdict = await permission.check(ctx, {
		action: "shell",
		title: "Run?",
		what: ["true"],
		toolCallId: "one",
		invocation: captureToolInvocation("one", "bash", { command: "true" })!,
	});
	expect(verdict).toMatchObject({ allowed: false, via: "hook" });
	const notes = fake.entries
		.map((entry) => (entry.data as { note?: unknown }).note)
		.filter((note): note is string => typeof note === "string");
	expect(notes).toHaveLength(1);
	const [note] = notes;
	expect(note).toMatch(/^blocked by policy⏎red /);
	expect(note).not.toMatch(/[\n\u001b]/);
	const parts = note.split("⏎");
	expect(parts).toHaveLength(2);
	for (const part of parts) expect(part.length).toBeLessThanOrEqual(160);
});
