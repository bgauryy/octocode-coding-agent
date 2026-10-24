import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { projectTrustForContents, saveDecision } from "../../src/octocode/shared/trust.ts";
import { fakeCtx } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
import { fingerprint, projectConfigFiles } from "../../src/octocode/shared/trust/files.ts";
it("authorizes the captured settings bytes rather than other bytes visible during trust", async () => {
	const cwd = tmp(),
		home = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".claude"));
	const file = path.join(cwd, ".claude", "settings.json");
	const trusted = JSON.stringify({ permissions: { allow: [] } }),
		captured = JSON.stringify({ permissions: { allow: ["Bash"] } });
	fs.writeFileSync(file, trusted);
	saveDecision(cwd, fingerprint(projectConfigFiles(cwd)), true, home);
	const ctx = { ...fakeCtx({ cwd }), isProjectTrusted: () => true };
	expect(await projectTrustForContents(ctx, new Map([[file, captured]]), home)).toBe(false);
	expect(await projectTrustForContents(ctx, new Map([[file, trusted]]), home)).toBe(true);
});
it("does not auto-adopt captured executable config based on nonexecutable live bytes", async () => {
	const cwd = tmp(),
		home = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".claude"));
	const file = path.join(cwd, ".claude", "settings.json");
	fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [] } }));
	const captured = JSON.stringify({
		permissions: { allow: ["Bash"] },
		hooks: {
			PreToolUse: [{ hooks: [{ type: "command", command: "echo requires review" }] }],
		},
	});
	const ctx = { ...fakeCtx({ cwd }), isProjectTrusted: () => true };
	expect(await projectTrustForContents(ctx, new Map([[file, captured]]), home)).toBe(false);
});
