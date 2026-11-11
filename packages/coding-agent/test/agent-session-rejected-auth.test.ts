import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL } from "@octocodeai/octocode-ai/api/anthropic-messages/token";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { createTestResourceLoader } from "./utilities.ts";

it("explains a saved unsupported credential before a prompt starts or any request is sent", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "octocode-rejected-auth-"));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "sk-ant-oat01-fixture" } }),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
	const { session } = await createTestSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: runtime.getModel("anthropic", "claude-sonnet-4-5"),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		noTools: "all",
	});
	try {
		expect(session.model).toBeDefined();
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
		await expect(session.prompt("hello")).rejects.toThrow(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
		expect(session.messages).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		session.dispose();
		fetch.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	}
});
