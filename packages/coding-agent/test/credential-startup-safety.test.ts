import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const roots: string[] = [];
const resourceLoaderOptions = {
	disabledFeatures: ["mcp", "llama.cpp"],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "octocode-credential-startup-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return { cwd: root, agentDir, authPath: join(agentDir, "auth.json") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("credential storage startup diagnostics", () => {
	it.skipIf(process.platform === "win32")(
		"reports unsafe modes without changing administrator-managed permissions",
		async () => {
			const { cwd, agentDir, authPath } = fixture();
			writeFileSync(authPath, "{}");
			chmodSync(authPath, 0o644);
			const { diagnostics } = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
			expect(diagnostics).toContainEqual({ type: "warning", message: expect.stringContaining("chmod 600") });
			expect(diagnostics.some((entry) => entry.message.includes(authPath))).toBe(true);
			expect(statSync(authPath).mode & 0o777).toBe(0o644);
		},
	);

	it("reports credential files inside a worktree through shared startup diagnostics", async () => {
		const { cwd, agentDir, authPath } = fixture();
		mkdirSync(join(cwd, ".git"));
		writeFileSync(authPath, "{}", { mode: 0o600 });
		const { diagnostics } = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
		expect(diagnostics).toContainEqual({
			type: "warning",
			message: expect.stringContaining("inside the git work tree"),
		});
	});

	it("does not inspect an unrelated credential file for an injected SDK model runtime", async () => {
		const { cwd, agentDir, authPath } = fixture();
		mkdirSync(join(cwd, ".git"));
		writeFileSync(authPath, "not-the-injected-runtime's-credentials");
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const { diagnostics } = await createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions });
		expect(diagnostics.filter((entry) => entry.message.includes("auth.json"))).toEqual([]);
	});
});
