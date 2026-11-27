import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashSessionEnv } from "../../src/core/tools/bash.ts";
import { applyBashEnvironmentSetting } from "../../src/octocode/files/bash-env.ts";
import { getShellEnv, setShellKeepsProviderKeys } from "../../src/utils/shell.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	setShellKeepsProviderKeys(false);
	vi.unstubAllEnvs();
});

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "HF_TOKEN", "GEMINI_API_KEY"];

function stubKeys(): void {
	for (const key of KEYS) vi.stubEnv(key, `fake-${key}`);
	vi.stubEnv("GH_TOKEN", "fake-gh");
	vi.stubEnv("MY_OWN_VAR", "kept");
}

describe("the bash environment", () => {
	it("leaves out provider keys by default and keeps a tool's own token", () => {
		stubKeys();
		for (const env of [getShellEnv(), bashSessionEnv(undefined)]) {
			for (const key of KEYS) expect(env[key], key).toBeUndefined();
			expect(env.GH_TOKEN).toBe("fake-gh");
			expect(env.MY_OWN_VAR).toBe("kept");
			expect(env.PATH).toBeDefined();
		}
		// The session itself keeps them: only what a command starts from changes.
		expect(process.env.OPENAI_API_KEY).toBe("fake-OPENAI_API_KEY");
	});

	it("keeps them with `bash.inheritProviderKeys`, read from the global settings only", () => {
		stubKeys();
		const agentDir = tmp();
		applyBashEnvironmentSetting(agentDir);
		expect(getShellEnv().OPENAI_API_KEY).toBeUndefined();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ bash: { inheritProviderKeys: true } }));
		applyBashEnvironmentSetting(agentDir);
		expect(getShellEnv().OPENAI_API_KEY).toBe("fake-OPENAI_API_KEY");
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ bash: { inheritProviderKeys: false } }));
		applyBashEnvironmentSetting(agentDir);
		expect(getShellEnv().OPENAI_API_KEY).toBeUndefined();
	});

	it("falls back to removing them when the setting cannot be read", () => {
		stubKeys();
		setShellKeepsProviderKeys(true);
		const notADirectory = path.join(tmp(), "file");
		fs.writeFileSync(notADirectory, "");
		applyBashEnvironmentSetting(notADirectory);
		expect(getShellEnv().OPENAI_API_KEY).toBeUndefined();
	});
});
