import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("native Octocode runtime", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "octocode-native-"));
		vi.stubEnv("OCTOCODE_HOME", root);
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("OCTOCODE_MCP", "0");
		vi.stubEnv("OCTOCODE_MODELS_DEV", "0");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps native tools when user extensions are disabled and registers once after reload", async () => {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
		});
		for (let pass = 0; pass < 2; pass++) {
			await loader.reload();
			const result = loader.getExtensions();
			expect(result.errors).toEqual([]);
			const native = result.extensions.filter((extension) => extension.path === "<inline:octocode>");
			expect(native).toHaveLength(1);
			expect([...native[0].tools.keys()]).toEqual(
				expect.arrayContaining(["file", "bash", "agent", "browser", "askUser"]),
			);
			expect(native[0].commands.has("status")).toBe(true);
			expect(native[0].handlers.has("tool_call")).toBe(true);
			expect(native[0].handlers.has("session_shutdown")).toBe(true);
		}
	});
});
