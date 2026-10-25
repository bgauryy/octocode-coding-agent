import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("model discovery CLI", () => {
	it.each([false, true])(
		"honors offline mode via environment: %s",
		(environment) => {
			const home = mkdtempSync(join(tmpdir(), "model-discovery-"));
			try {
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						"./scripts/source-resolver.ts",
						"./src/cli.ts",
						"models",
						"discover",
						"--provider",
						"openai",
						"--json",
						...(environment ? [] : ["--offline"]),
					],
					{
						cwd: new URL("..", import.meta.url),
						encoding: "utf8",
						timeout: 30_000,
						env: { ...process.env, OCTOCODE_CODING_AGENT_DIR: home, OCTOCODE_OFFLINE: environment ? "1" : "0" },
					},
				);
				expect(result.status, result.stderr).toBe(0);
				const [discovery] = JSON.parse(result.stdout);
				expect(discovery).toMatchObject({ provider: "openai", status: "catalog" });
				expect(discovery.models.length).toBeGreaterThan(0);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
		40_000,
	);
});
