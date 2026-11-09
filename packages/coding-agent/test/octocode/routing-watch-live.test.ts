import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { providerSourceGate, watchProviderSettings } from "../../src/core/provider-sources/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ToolDefinition } from "../../src/core/features/index.ts";
import { registerModelsTool } from "../../src/octocode/subagents/models-tool.ts";
import { ROUTING_NOTICE_ID } from "../../src/octocode/subagents/routing-watch.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections } from "./helpers.ts";

let home: string;
const stops: Array<() => void> = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "octocode-routing-live-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	vi.stubEnv("OCTOCODE_MODELS_DEV", "0");
	providerSourceGate.set({});
});
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	providerSourceGate.set({});
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("a provider another process disables", () => {
	it("reaches the running coordinator as a routing notice that no longer lists it", async () => {
		const agentDir = join(home, "agent");
		mkdirSync(dirname(join(agentDir, "auth.json")), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				cerebras: { type: "api_key", key: "k" },
				groq: { type: "api_key", key: "k" },
			}),
		);
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const running = SettingsManager.create(join(home, "project"), agentDir);
		stops.push(watchProviderSettings(running, runtime, {}));
		const available = () => registry.getAvailable();
		const session = available().find((model) => model.provider === "groq");
		expect(session).toBeDefined();
		expect(new Set(available().map((model) => model.provider))).toContain("cerebras");

		const fake = fakeHost();
		for (const name of ["bash", "file", "agent"]) fake.tools.set(name, { name });
		fake.api.setActiveTools(["bash", "file", "agent"]);
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const ctx = { hasUI: true, model: session, modelRegistry: registry };
		const turn = async () => {
			const event = { systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {} } };
			const [result] = (await fake.emit("before_agent_start", event, ctx)) as Array<
				{ message?: { customType: string; content: string; display: boolean } } | undefined
			>;
			return { prompt: allSections(event).delegation ?? "", message: result?.message };
		};

		let models: ToolDefinition | undefined;
		registerModelsTool(
			{ registerTool: (definition: ToolDefinition) => void (models = definition) } as never,
			() => new Map(),
		);
		const listed = async () => {
			const result = await models!.execute("c", {}, undefined, undefined, ctx as never);
			return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		};
		expect(await listed()).toMatch(/^ {2}cerebras · /m);

		const first = await turn();
		expect(first.prompt).toMatch(/providers: .*`cerebras` \(\d+\).*`groq` \(\d+\)/);
		expect(first.message).toBeUndefined();

		// Another process (a web page, a second terminal) saves the switch.
		const other = SettingsManager.create(join(home, "project"), agentDir);
		other.setDisabledProviders(["cerebras"]);
		await other.flush();
		await expect.poll(() => available().some((model) => model.provider === "cerebras"), { timeout: 5000 }).toBe(false);

		const next = await turn();
		// The cached prompt keeps its line; the notice carries the change.
		expect(next.prompt).toBe(first.prompt);
		expect(next.message).toMatchObject({ customType: ROUTING_NOTICE_ID, display: false });
		expect(next.message?.content).toContain("(no longer available: `cerebras`)");
		expect(next.message?.content).toMatch(/Providers \(models that can run a task\): `groq` \(\d+\)/);
		expect(next.message?.content).not.toMatch(/Providers[^.]*`cerebras` \(/);
		const after = await listed();
		expect(after).toMatch(/^ {2}groq · /m);
		expect(after).not.toMatch(/^ {2}cerebras · /m);
	});
});
