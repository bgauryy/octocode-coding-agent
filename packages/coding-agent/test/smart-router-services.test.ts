import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

const roots: string[] = [];
const disposers: Array<(() => void) | undefined> = [];
const resourceLoaderOptions = {
	nativeFeatures: nativeFeatureSet(),
	disabledFeatures: ["mcp"],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
};

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "octocode-smart-router-services-"));
	roots.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	return { cwd, agentDir };
}

function writeSettings(path: string, value: unknown) {
	writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose?.();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production smart-router services", () => {
	it("registers auto-code and applies configured candidate patterns", async () => {
		const { cwd, agentDir } = fixture();
		writeSettings(join(agentDir, "settings.json"), {
			runtime: { smartRouting: { allow: ["fixture/cheap"] } },
		});
		writeSettings(join(agentDir, "models.json"), {
			providers: {
				fixture: {
					baseUrl: "https://fixture.example.com/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [
						{ id: "cheap", contextWindow: 100_000, maxTokens: 8192 },
						{ id: "other", contextWindow: 100_000, maxTokens: 8192 },
					],
				},
			},
		});
		const services = await createAgentSessionServices({ cwd, agentDir, unattended: true, resourceLoaderOptions });
		disposers.push(services.dispose);

		const virtual = services.modelRuntime.getModel("octocode", "auto-code");
		expect(virtual).toBeDefined();
		const route = await services.modelRuntime.resolveModel(virtual!, [], { reason: "user", thinkingLevel: "low" });
		expect(route.model).toMatchObject({ provider: "fixture", id: "cheap" });
	});

	it("does not make auto-code the implicit default without a physical model", async () => {
		const { cwd, agentDir } = fixture();
		const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions });
		disposers.push(services.dispose);

		expect(services.modelRuntime.getModel("octocode", "auto-code")).toBeDefined();
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: services.modelRuntime,
		});
		expect(initial.model).toBeUndefined();
	});

	it("does not let project settings enable plan-to-metered escalation", () => {
		const { cwd, agentDir } = fixture();
		writeSettings(join(agentDir, "settings.json"), {
			runtime: { smartRouting: { allowPlanToMeteredEscalation: false } },
		});
		mkdirSync(join(cwd, ".octocode"));
		writeSettings(join(cwd, ".octocode", "settings.json"), {
			runtime: { smartRouting: { allowPlanToMeteredEscalation: true, planOnly: true } },
		});
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });

		expect(settings.getSmartRouterSettings()).toMatchObject({
			allowPlanToMeteredEscalation: false,
			planOnly: true,
		});
	});
});
