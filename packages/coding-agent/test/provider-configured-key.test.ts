import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keychainReadCommand, overrideKeychainHost } from "../src/core/auth-storage/keychain.ts";
import { clearConfigValueCache } from "../src/core/config-value.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, configuredRequestAuthStatus } from "../src/core/provider-composer.ts";

const node = process.execPath;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-configured-key-"));
	clearConfigValueCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	clearConfigValueCache();
	rmSync(dir, { recursive: true, force: true });
});

async function load(provider: Record<string, unknown>) {
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				gw: { baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [{ id: "m" }], ...provider },
			},
		}),
	);
	return ModelConfig.load(path);
}

async function resolve(provider: Record<string, unknown>, env: Record<string, string> = {}) {
	const config = await load(provider);
	expect(config.getError()).toBeUndefined();
	const composed = composeModelProvider("gw", undefined, config, undefined);
	const ctx = { env: async (name: string) => env[name], fileExists: async () => false };
	const apiKey = composed.auth.apiKey;
	if (!apiKey) throw new Error("no api key auth");
	const signal = new AbortController().signal;
	return {
		check: () => apiKey.check?.({ ctx, signal }),
		resolve: () => apiKey.resolve({ ctx, signal }),
		status: configuredRequestAuthStatus(config.getProvider("gw"), undefined),
	};
}

describe("models.json auth command", () => {
	it("uses the command's stdout as the key, registers it for redaction, and renews it", async () => {
		const counter = join(dir, "runs");
		const script = `const fs=require("fs");const n=(fs.existsSync(${JSON.stringify(counter)})?1:0)+1;fs.writeFileSync(${JSON.stringify(counter)},"x");process.stdout.write("cmd-key-value-"+n)`;
		const entry = await resolve({ auth: { command: node, args: ["-e", script], ttlMs: 60_000 } });
		expect(entry.status).toEqual({ configured: true, source: "models_json_command" });
		const first = await entry.resolve();
		expect(first?.auth.apiKey).toBe("cmd-key-value-1");
		expect(redactSecrets("request failed for cmd-key-value-1")).not.toContain("cmd-key-value-1");
		expect((await entry.resolve())?.auth.apiKey).toBe("cmd-key-value-1");
		first?.renew?.();
		expect((await entry.resolve())?.auth.apiKey).toBe("cmd-key-value-2");
	});

	it("fails with the command's exit status and stderr, never the key in the message", async () => {
		const entry = await resolve({
			auth: { command: node, args: ["-e", 'console.error("not logged in to vault");process.exit(2)'] },
		});
		await expect(entry.resolve()).rejects.toThrow(
			/API key for provider "gw".*exited with status 2: not logged in to vault/,
		);
	});

	it("rejects unknown fields and a non-positive timeout", async () => {
		const config = await load({ auth: { command: "x", timeoutMs: 0, shell: true } });
		expect(config.getError()).toContain("Invalid models.json schema");
	});
});

describe("models.json env names", () => {
	it("takes the first variable that is set, else apiKey, else reports none", async () => {
		const entry = await resolve({ env: ["GW_A", "GW_B"] }, { GW_B: "env-key-b" });
		expect(await entry.check()).toEqual({ type: "api_key", source: expect.any(String) });
		expect(await entry.resolve()).toMatchObject({ auth: { apiKey: "env-key-b" }, source: "GW_B" });

		const fallback = await resolve({ env: ["GW_A"], apiKey: "literal-key" });
		expect((await fallback.resolve())?.auth.apiKey).toBe("literal-key");

		const none = await resolve({ env: ["GW_A"] });
		expect(none.status).toEqual({ configured: false });
		expect(await none.check()).toBeUndefined();
		await expect(none.resolve()).rejects.toThrow("None of GW_A is set");
	});
});

describe("apiKey keychain:<name>", () => {
	it("reads the platform keychain without a shell", () => {
		const which = (command: string) => command;
		expect(keychainReadCommand("gw-key", "darwin", which)).toEqual({
			command: "/usr/bin/security",
			args: ["find-generic-password", "-s", "octocode", "-a", "gw-key", "-w"],
			timeoutMs: 60_000,
		});
		expect(keychainReadCommand("gw-key", "linux", which)).toEqual({
			command: "secret-tool",
			args: ["lookup", "service", "octocode", "account", "gw-key"],
			timeoutMs: 60_000,
		});
		expect(keychainReadCommand("gw-key", "win32", which).command).toBe("powershell.exe");
	});

	it("says no keychain is available, and refuses an invalid name", () => {
		expect(() => keychainReadCommand("gw-key", "linux", () => undefined)).toThrow(/none is available on this host/);
		expect(() => keychainReadCommand("gw-key", "freebsd", (command) => command)).toThrow(/none is available/);
		expect(() => keychainReadCommand("bad name", "darwin", (command) => command)).toThrow(
			/Invalid keychain entry name/,
		);
	});

	afterEach(() => overrideKeychainHost(undefined));

	/** A fake keychain program named `name` that writes `stderr` and exits with `status`. */
	function fakeKeychainTool(name: string, status: number, stderr: string): string {
		const file = join(dir, name);
		writeFileSync(file, `#!${node}\nprocess.stderr.write(${JSON.stringify(stderr)});process.exit(${status});\n`);
		chmodSync(file, 0o755);
		return file;
	}

	it.each([
		{
			platform: "darwin" as const,
			tool: "security",
			status: 44,
			stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
		},
		{ platform: "linux" as const, tool: "secret-tool", status: 1, stderr: "" },
	])("names the cause of a missing entry on $platform", async ({ platform, tool, status, stderr }) => {
		overrideKeychainHost({ platform, which: () => fakeKeychainTool(tool, status, stderr) });
		const entry = await resolve({ apiKey: "keychain:octocode-test-missing-entry-b218" });
		expect(entry.status).toMatchObject({ configured: true, label: "keychain entry octocode-test-missing-entry-b218" });
		// The provider stays reported as configured, so the cause shows at request time, not as a silent fallback.
		await expect(entry.resolve()).rejects.toThrow(
			`Failed to resolve API key for provider "gw": Credential command "${tool}" exited with status ${status}${stderr ? `: ${stderr.trim()}` : ""}`,
		);
		// `check` does not read the keychain (no prompt, no run): the cause appears only on a request.
		await expect(entry.check()).resolves.toMatchObject({ type: "api_key" });
	});

	it("fails with the cause when the host has no keychain", async () => {
		overrideKeychainHost({ platform: "linux", which: () => undefined });
		const entry = await resolve({ apiKey: "keychain:gw-key" });
		await expect(entry.resolve()).rejects.toThrow(/API key for provider "gw".*none is available on this host/);
	});
});
