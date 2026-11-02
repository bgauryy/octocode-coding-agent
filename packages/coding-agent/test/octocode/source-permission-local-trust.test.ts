import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});
async function run(kind: "plain" | "tracked" | "symlink" | "project") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-permission-trust-"));
	roots.push(root);
	const cwd = path.join(root, "work"),
		home = path.join(root, "home");
	fs.mkdirSync(cwd);
	fs.mkdirSync(home);
	vi.stubEnv("CLAUDE_CONFIG_DIR", home);
	if (kind === "symlink") {
		fs.mkdirSync(path.join(root, "other"));
		fs.symlinkSync(path.join(root, "other"), path.join(cwd, ".claude"));
	} else fs.mkdirSync(path.join(cwd, ".claude"));
	const settings = path.join(cwd, ".claude", kind === "project" ? "settings.json" : "settings.local.json");
	fs.writeFileSync(
		settings,
		JSON.stringify({
			permissions: { allow: ["Bash"] },
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "untrusted" }] }],
			},
		}),
	);
	if (kind === "tracked") {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "-f", ".claude/settings.local.json"], { cwd });
	}
	const fake = fakeHost();
	const owner = registerSourcePolicy(fake.api, home);
	// A session that does not trust the folder: only the user's own untracked local file may allow.
	await owner.refresh({ ...fakeCtx({ cwd, hasUI: false }), isProjectTrusted: () => false });
	return owner.evaluate(
		{
			active: true,
			toolCallId: "x",
			toolName: "bash",
			input: { command: "true" },
		},
		cwd,
	).decision;
}
it("loads untracked local source permission allowances without granting project hook trust", async () => {
	expect(await run("plain")).toBe("allow");
});
it.each(["tracked", "symlink", "project"] as const)(
	"withholds %s allowances when the session does not trust the folder",
	async (kind) => {
		expect(await run(kind)).toBe("none");
	},
);
