import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { providerSourceGate } from "../src/core/provider-sources/gate.ts";
import { runAuthCommand } from "../src/main/auth-command.ts";

let home: string;
let agentDir: string;
let originalExitCode: typeof process.exitCode;

function write(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-auth-command-sources-"));
	agentDir = join(home, ".octocode", "octocodecode");
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("CEREBRAS_API_KEY", "");
	providerSourceGate.set({});
});

afterEach(() => {
	process.exitCode = originalExitCode;
	providerSourceGate.set({});
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("auth command credential sources", () => {
	test.each([false, true])("checks Pi credentials with no-refresh=%s", async (noRefresh) => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		write(piAuth, { cerebras: { type: "api_key", key: "pi-test-key" } });
		const before = readFileSync(piAuth, "utf8");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runAuthCommand([
			"auth",
			"check",
			"--provider",
			"cerebras",
			"--json",
			"--credentials",
			...(noRefresh ? ["--no-refresh"] : []),
		]);

		expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toEqual({
			status: "ready",
			provider: "cerebras",
			authType: "api_key",
			source: "stored credential",
			verified: false,
			credentials: "pi-test-key",
		});
		expect(process.exitCode).toBe(0);
		expect(readFileSync(piAuth, "utf8")).toBe(before);
		if (noRefresh) expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(existsSync(join(agentDir, "models-store.json"))).toBe(false);
	});

	test("reads an expired Pi OAuth token without refreshing or creating Octocode credentials", async () => {
		const piAuth = join(home, ".pi", "agent", "auth.json");
		write(piAuth, {
			openai: { type: "oauth", access: "pi-expired-test-token", refresh: "fixture-refresh", expires: 0 },
		});
		const before = readFileSync(piAuth, "utf8");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runAuthCommand(["auth", "check", "--provider", "openai", "--credentials", "--no-refresh"]);

		expect(stdout).toHaveBeenLastCalledWith("pi-expired-test-token\n");
		expect(process.exitCode).toBe(0);
		expect(readFileSync(piAuth, "utf8")).toBe(before);
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
	});

	test.each(["check", "print-api-key"])("%s respects a disabled Pi source", async (command) => {
		write(join(home, ".pi", "agent", "auth.json"), { cerebras: { type: "api_key", key: "pi-hidden-test-key" } });
		write(join(agentDir, "settings.json"), { providerSources: { pi: false } });
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await runAuthCommand(["auth", command, "--provider", "cerebras"]);

		expect(process.exitCode).toBe(1);
		expect(stdout.mock.calls.map(([text]) => String(text)).join("")).not.toContain("pi-hidden-test-key");
		expect(providerSourceGate.isEnabled("pi")).toBe(false);
	});

	test("names a models.json key by the words /providers uses: the file, its secret command, or the variable", async () => {
		vi.stubEnv("R2_GATEWAY_KEY", "env-test-key");
		const provider = (apiKey: string) => ({
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey,
			models: [{ id: "m" }],
		});
		write(join(agentDir, "models.json"), {
			providers: {
				literal: provider("fixture-literal-key"),
				command: provider("!echo fixture"),
				variable: provider("$R2_GATEWAY_KEY"),
			},
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const sources: Record<string, unknown> = {};
		for (const id of ["literal", "command", "variable"]) {
			await runAuthCommand(["auth", "check", "--provider", id, "--json"]);
			sources[id] = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).source;
		}
		expect(sources).toEqual({
			literal: "models.json",
			command: "secret command in models.json",
			variable: "R2_GATEWAY_KEY",
		});
	});
});

describe("auth check --model", () => {
	test("resolves the model as a session's --model does: to the matching provider that has credentials", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runAuthCommand(["auth", "check", "--model", "sonnet", "--json"]);

		expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
			status: "ready",
			provider: "anthropic",
			source: "ANTHROPIC_API_KEY",
		});
		expect(process.exitCode).toBe(0);
		expect(existsSync(join(agentDir, "models-store.json"))).toBe(false);
	});

	test("reports the resolver's error for a model it cannot resolve", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		await runAuthCommand(["auth", "check", "--model", "no-such-model-xyz", "--json"]);

		expect(stdout).not.toHaveBeenCalled();
		expect(String(stderr.mock.calls[0]?.[0])).toContain('Model "no-such-model-xyz" not found');
		expect(process.exitCode).toBe(2);
	});
});
