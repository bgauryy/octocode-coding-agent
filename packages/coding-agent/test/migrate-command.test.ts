import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDirPath } from "../src/core/session-manager/storage.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;

describe("explicit historical migrations", () => {
	it("leaves old files intact during startup and help, then converts only on migrate", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-migrate-"));
		const home = join(root, "config");
		const project = join(root, ".octocode");
		mkdirSync(join(home, "commands"), { recursive: true });
		mkdirSync(join(project, "commands"), { recursive: true });
		mkdirSync(join(home, "hooks"));
		const keys = JSON.stringify({ expandTools: "ctrl+y" });
		writeFileSync(join(home, "keybindings.json"), keys);
		writeFileSync(
			join(home, "settings.json"),
			JSON.stringify({ apiKeys: { example: "fixture-only", retained: "legacy-fixture" } }),
		);
		const env = {
			...process.env,
			OCTOCODE_HOME: home,
			OCTOCODE_CODING_AGENT_DIR: home,
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_API: "0",
			OCTOCODE_MCP: "0",
			OCTOCODE_MODELS_DEV: "0",
		};
		const options = { cwd: root, env, encoding: "utf8" as const, timeout: 30_000 };
		const run = (args: string[]) => execFileSync(process.execPath, ["--import", resolver, cli, ...args], options);
		try {
			run(["--offline", "--list-models", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve"]);
			expect(run(["migrate", "--help"])).toContain("Usage: octocode migrate");
			const invalid = spawnSync(process.execPath, ["--import", resolver, cli, "migrate", "--invalid"], options);
			expect(invalid.status).toBe(1);
			expect(existsSync(join(home, "commands"))).toBe(true);
			expect(existsSync(join(project, "commands"))).toBe(true);
			expect(readFileSync(join(home, "keybindings.json"), "utf8")).toBe(keys);
			expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).apiKeys).toEqual({
				example: "fixture-only",
				retained: "legacy-fixture",
			});
			writeFileSync(join(home, "auth.json"), JSON.stringify({ retained: { type: "api_key", key: "native-fixture" } }));
			const output = run(["migrate"]);
			expect(output).toContain("Migration checks completed");
			expect(output).toContain("github.com/bgauryy/octocodecode/");
			expect(output).not.toContain("Press any key");
			expect(existsSync(join(home, "commands"))).toBe(false);
			expect(existsSync(join(home, "prompts"))).toBe(true);
			expect(existsSync(join(project, "prompts"))).toBe(true);
			expect(JSON.parse(readFileSync(join(home, "keybindings.json"), "utf8"))).toEqual({
				"app.tools.expand": "ctrl+y",
			});
			expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).toEqual({
				example: { type: "api_key", key: "fixture-only" },
				retained: { type: "api_key", key: "native-fixture" },
			});
			expect(run(["migrate"])).not.toContain("Migrated credentials");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);

	it("moves a root-level session into the folder the session listing reads for its cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-migrate-sessions-"));
		const home = join(root, "config");
		const project = join(root, "proj");
		mkdirSync(home, { recursive: true });
		// A header cwd written with a trailing separator names the same directory as `project`.
		const header = {
			type: "session",
			version: 3,
			id: "legacy-1",
			timestamp: new Date(0).toISOString(),
			cwd: `${project}/`,
		};
		writeFileSync(join(home, "legacy.jsonl"), `${JSON.stringify(header)}\n`);
		const env = { ...process.env, OCTOCODE_HOME: home, OCTOCODE_CODING_AGENT_DIR: home, OCTOCODE_OFFLINE: "1" };
		try {
			const result = spawnSync(process.execPath, ["--import", resolver, cli, "migrate"], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(result.status).toBe(0);
			expect(existsSync(join(getDefaultSessionDirPath(project, home), "legacy.jsonl"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("does not write auth.json or retire legacy keys while another process holds the auth lock", () => {
		const root = mkdtempSync(join(tmpdir(), "octocode-migrate-lock-"));
		const home = join(root, "config");
		mkdirSync(home, { recursive: true });
		const settings = JSON.stringify({ apiKeys: { example: "fixture-only" } });
		writeFileSync(join(home, "settings.json"), settings);
		const auth = JSON.stringify({ retained: { type: "api_key", key: "native-fixture" } });
		writeFileSync(join(home, "auth.json"), auth);
		// A fresh `proper-lockfile` lock: a running session is writing auth.json (a token refresh, a login).
		mkdirSync(join(home, "auth.json.lock"));
		const env = {
			...process.env,
			OCTOCODE_HOME: home,
			OCTOCODE_CODING_AGENT_DIR: home,
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_API: "0",
			OCTOCODE_MCP: "0",
			OCTOCODE_MODELS_DEV: "0",
		};
		try {
			const result = spawnSync(process.execPath, ["--import", resolver, cli, "migrate"], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(result.status).not.toBe(0);
			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(auth);
			expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(settings);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
