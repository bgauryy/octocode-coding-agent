import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
