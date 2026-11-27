import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "../../helpers/features.ts";
import type { FeatureSetup, FeatureRegister } from "../../../src/core/features/index.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader/types.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("extension event-bus lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("removes extension-owned event-bus listeners on reload and dispose", async () => {
		const eventBus = createEventBus();
		let featureCalls = 0;
		let hostCalls = 0;
		let firstApi: FeatureSetup | undefined;
		const factory: FeatureRegister = (api) => {
			firstApi ??= api;
			api.channels.on("reload:test", () => featureCalls++);
		};
		eventBus.on("reload:test", () => hostCalls++);

		const loadFeatures = async () => {
			const runtime = createFeatureRuntime();
			const feature = await loadFeatureFromFactory(factory, process.cwd(), eventBus, runtime);
			return { features: [feature], errors: [], runtime };
		};
		let featuresResult = await loadFeatures();
		const resourceLoader: ResourceLoader = {
			getFeatures: () => featuresResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				featuresResult = await loadFeatures();
			},
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindFeatures({ shutdownHandler: () => {} });

		const emit = async () => {
			const featureBefore = featureCalls;
			const hostBefore = hostCalls;
			eventBus.emit("reload:test", undefined);
			await new Promise((resolve) => setImmediate(resolve));
			return { extension: featureCalls - featureBefore, host: hostCalls - hostBefore };
		};

		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(() => firstApi?.resources.getCommands()).toThrow("stale after session replacement or reload");
		expect(() => firstApi?.resources.getSkillDirectories()).toThrow("stale after session replacement or reload");
		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(await emit()).toEqual({ extension: 1, host: 1 });

		harness.session.dispose();
		expect(await emit()).toEqual({ extension: 0, host: 1 });
	});
});
