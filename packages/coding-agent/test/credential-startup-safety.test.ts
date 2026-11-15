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

	it("warns about a models.json provider whose models have no credential", async () => {
		const { cwd, agentDir } = fixture();
		const provider = (apiKey?: string) => ({
			baseUrl: "https://gateway.example.com",
			api: "anthropic-messages",
			...(apiKey ? { apiKey } : {}),
			models: [{ id: "gateway-model" }],
		});
		const models = { providers: { "keyless-gateway": provider(), "keyed-gateway": provider("literal-test-key") } };
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(models), { mode: 0o600 });
		const { diagnostics } = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
		const missing = diagnostics.filter((entry) => entry.message.includes("has no credential"));
		expect(missing).toEqual([{ type: "warning", message: expect.stringContaining('"keyless-gateway"') }]);
	});

	it("names the unset environment variable instead of asking for an apiKey", async () => {
		const { cwd, agentDir } = fixture();
		const models = {
			providers: {
				"env-gateway": {
					baseUrl: "https://gateway.example.com",
					api: "anthropic-messages",
					apiKey: "$OCTOCODE_TEST_UNSET_KEY_B429",
					models: [{ id: "gateway-model" }],
				},
			},
		};
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(models), { mode: 0o600 });
		const { diagnostics } = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
		const missing = diagnostics.filter((entry) => entry.message.includes('"env-gateway"'));
		expect(missing).toHaveLength(1);
		expect(missing[0]?.message).toContain("apiKey uses $OCTOCODE_TEST_UNSET_KEY_B429, which is not set");
		expect(missing[0]?.message).not.toContain('Add "apiKey"');
	});

	it("leaves a failing !command key configured; the command is checked on first use", async () => {
		const { cwd, agentDir } = fixture();
		const models = {
			providers: {
				"cmd-gateway": {
					baseUrl: "https://gateway.example.com",
					api: "anthropic-messages",
					apiKey: "!false",
					models: [{ id: "gateway-model" }],
				},
			},
		};
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(models), { mode: 0o600 });
		const { diagnostics, modelRuntime } = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
		expect(modelRuntime.hasConfiguredAuth("cmd-gateway")).toBe(true);
		expect(diagnostics.filter((entry) => entry.message.includes("cmd-gateway"))).toEqual([]);
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
