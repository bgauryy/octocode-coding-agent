import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * A Claude `defaultMode: "acceptEdits"` lets workspace edits run unasked. Like an `allow` rule, it is an allowance, so an
 * untrusted project's `.claude/settings.json` must not turn it on; the user's own untracked `settings.local.json` may.
 * Manual mode asks before a workspace edit (the file tool's `file.workspace` check); with no UI the ask is a refusal.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

async function editInManualMode(settingsFile: "settings.json" | "settings.local.json" | undefined) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-mode-trust-"));
	roots.push(root);
	const cwd = path.join(root, "work");
	const home = path.join(root, "home");
	fs.mkdirSync(cwd);
	fs.mkdirSync(home);
	vi.stubEnv("CLAUDE_CONFIG_DIR", home);
	if (settingsFile) {
		fs.mkdirSync(path.join(cwd, ".claude"));
		fs.writeFileSync(
			path.join(cwd, ".claude", settingsFile),
			JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
		);
	}
	const fake = fakeHost();
	const ctx = { ...fakeCtx({ cwd, hasUI: false }), isProjectTrusted: () => false };
	const policy = registerSourcePolicy(fake.api, home);
	await policy.refresh(ctx);
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "manual" }, isSubagent: false });
	permission.start(ctx);
	permission.setSourcePolicy(policy.evaluate, policy.unprojected);
	const input = { queries: [{ type: "write", path: "notes.txt", content: "x" }] };
	const verdict = await permission.check(ctx, {
		action: "file.workspace",
		invocation: captureToolInvocation("w1", "file", input),
		title: "Apply these file changes?",
		what: ["write notes.txt"],
		toolCallId: "w1",
		cwd,
	});
	return verdict.allowed;
}

it("ignores acceptEdits from an untrusted project's settings", async () => {
	expect(await editInManualMode("settings.json")).toBe(false);
});

it("applies acceptEdits from the user's untracked local settings", async () => {
	expect(await editInManualMode("settings.local.json")).toBe(true);
});

it("asks without any Claude settings", async () => {
	expect(await editInManualMode(undefined)).toBe(false);
});
