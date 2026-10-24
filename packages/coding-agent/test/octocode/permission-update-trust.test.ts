import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { preparePermissionTrustUpdate, projectTrustNow, saveDecision } from "../../src/octocode/shared/trust.ts";
import { tmp } from "./helpers.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";

beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp("permission-trust-home-"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp("permission-trust-agent-"));
	vi.stubEnv("OCTOCODE_SUBAGENT", undefined);
	vi.stubEnv("OCTOCODE_TRUST_ROOT", undefined);
});
function fixture(trusted = true) {
	const cwd = tmp("permission-trust-project-");
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".claude"));
	const file = path.join(cwd, ".claude/settings.json");
	const before = JSON.stringify({
		hooks: { SessionStart: [] },
		permissions: { deny: ["Bash(unsafe)"] },
	});
	const after = JSON.stringify({
		hooks: { SessionStart: [] },
		permissions: { deny: ["Bash(unsafe)"], allow: ["Bash(node -p 42)"] },
	});
	fs.writeFileSync(file, before);
	const ctx = { cwd, isProjectTrusted: () => true };
	saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), trusted);
	const commit = preparePermissionTrustUpdate(ctx, new Map([[file, { before, after }]]));
	return { cwd, file, before, after, ctx, commit };
}
it("advances only an already trusted permission-only successor", () => {
	const f = fixture();
	fs.writeFileSync(f.file, f.after);
	expect(f.commit([f.file])).toBe(true);
	expect(projectTrustNow(f.ctx)).toBe(true);
});
it("does not promote an untrusted project", () => {
	const f = fixture(false);
	fs.writeFileSync(f.file, f.after);
	expect(f.commit([f.file])).toBe(false);
	expect(projectTrustNow(f.ctx)).not.toBe(true);
});
it("rejects concurrent executable settings changes", () => {
	const f = fixture();
	fs.writeFileSync(f.file, f.after);
	fs.writeFileSync(
		path.join(f.cwd, ".claude/settings.local.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "echo changed" }] }],
			},
		}),
	);
	expect(f.commit([f.file])).toBe(false);
	expect(projectTrustNow(f.ctx)).not.toBe(true);
});
it("does not overwrite a concurrent trust revocation", () => {
	const f = fixture();
	saveDecision(f.cwd, fingerprint(projectConfigFiles(f.cwd)), false);
	fs.writeFileSync(f.file, f.after);
	expect(f.commit([f.file])).toBe(false);
	expect(projectTrustNow(f.ctx)).not.toBe(true);
});
it("rejects a staged change to unrelated hook settings", () => {
	const f = fixture();
	const after = JSON.stringify({
		hooks: { SessionStart: [{ command: "new" }] },
		permissions: { allow: ["Bash"] },
	});
	const commit = preparePermissionTrustUpdate(f.ctx, new Map([[f.file, { before: f.before, after }]]));
	fs.writeFileSync(f.file, after);
	expect(commit([f.file])).toBe(false);
});
