import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { nativeHost } from "../../src/octocode/shared/host-api.ts";
import type { ExtensionAPI } from "../../src/core/features/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Resume and `--tools`: tools activated by name come back when the allowlist and tool policy permit them. */
describe("AgentSession restore of loaded tools with an explicit --tools allowlist", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** Tools that registration does not activate: only naming them does. */
	const registerOptIn = (api: ExtensionAPI, names: readonly string[]) => {
		for (const name of names) {
			api.registerTool({
				name,
				label: name,
				description: `Opt-in tool ${name}.`,
				defaultActive: false,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
		}
	};
	const optInTools = (api: ExtensionAPI) => registerOptIn(api, ["gem_one", "gem_two"]);

	async function start(options: {
		allowedToolNames?: string[];
		initialActiveToolNames?: string[];
		sessionManager?: SessionManager;
	}) {
		const harness = await createHarness({ ...options, extensionFactories: [optInTools] });
		harnesses.push(harness);
		return harness;
	}

	/** A session that activated both tools, with the loadout recorded in its transcript. */
	async function loadBoth() {
		const first = await start({});
		first.session.setActiveToolsByName(["gem_one", "gem_two"]);
		first.setResponses([fauxAssistantMessage("loaded")]);
		await first.session.prompt("go");
		return first;
	}

	it("keeps a loaded tool the allowlist permits after resume", async () => {
		const first = await loadBoth();
		const second = await start({
			allowedToolNames: ["gem_one"],
			initialActiveToolNames: [],
			sessionManager: first.sessionManager,
		});
		expect(second.session.getActiveToolNames()).toEqual(["gem_one"]);
	});

	it("does not restore a loaded tool outside the allowlist", async () => {
		const first = await loadBoth();
		const second = await start({
			allowedToolNames: ["gem_two"],
			initialActiveToolNames: [],
			sessionManager: first.sessionManager,
		});
		expect(second.session.getActiveToolNames()).toEqual(["gem_two"]);
	});

	it("control: an allowlist that names a tool activates it although registration does not", async () => {
		const fresh = await start({ allowedToolNames: ["gem_one", "gem_two"], initialActiveToolNames: [] });
		expect(fresh.session.getActiveToolNames()).toEqual(["gem_one", "gem_two"]);
	});

	it("resumes a transcript that recorded tool_search without declaring it", async () => {
		const first = await createHarness({
			extensionFactories: [(api) => registerOptIn(api, ["gem_one", "tool_search"])],
		});
		harnesses.push(first);
		first.session.setActiveToolsByName(["gem_one", "tool_search"]);
		first.setResponses([fauxAssistantMessage("loaded")]);
		await first.session.prompt("go");
		const second = await createHarness({
			extensionFactories: [optInTools],
			sessionManager: first.sessionManager,
		});
		harnesses.push(second);
		expect(second.session.getActiveToolNames()).not.toContain("tool_search");
		second.setResponses([fauxAssistantMessage("still fine")]);
		await second.session.prompt("again");
		expect(second.session.agent.state.tools.map((tool) => tool.name)).not.toContain("tool_search");
	});

	it("restores nothing without an allowlist or default tools", async () => {
		const first = await loadBoth();
		const second = await start({ initialActiveToolNames: [], sessionManager: first.sessionManager });
		expect(second.session.getActiveToolNames()).toEqual([]);
	});

	// The tool policy is set after construction (an extension calls `api.setToolPolicy` once the session is bound), so
	// these tests check the loadout after the policy is applied to the resumed session.
	describe("after setToolPolicy is applied to a resumed session", () => {
		async function resume(allowedToolNames: string[], allows: ((name: string) => boolean) | undefined) {
			const first = await loadBoth();
			let api: ExtensionAPI | undefined;
			const second = await createHarness({
				allowedToolNames,
				initialActiveToolNames: [],
				sessionManager: first.sessionManager,
				// Native features own the tool policy, so the extensions load under the native feature path.
				builtinCompactionFactories: [
					optInTools,
					(host) => {
						api = host;
					},
				],
			});
			harnesses.push(second);
			const restored = second.session.getActiveToolNames();
			if (allows) nativeHost(api!).setToolPolicy?.(allows);
			return { second, restored };
		}

		it("restores a loaded tool only when both the allowlist and the policy permit it", async () => {
			const { second, restored } = await resume(["gem_one", "gem_two"], (name) => name !== "gem_two");
			expect(restored).toEqual(["gem_one", "gem_two"]);
			expect(second.session.getActiveToolNames()).toEqual(["gem_one"]);
		});

		it("keeps a tool out when the policy permits it but the allowlist does not", async () => {
			const { second } = await resume(["gem_one"], () => true);
			expect(second.session.getActiveToolNames()).toEqual(["gem_one"]);
		});

		it("drops a tool the allowlist permits when the policy refuses it", async () => {
			const { second } = await resume(["gem_one"], (name) => name !== "gem_one");
			expect(second.session.getActiveToolNames()).toEqual([]);
		});

		it("keeps both tools when allowlist and policy permit both", async () => {
			const { second } = await resume(["gem_one", "gem_two"], () => true);
			expect(second.session.getActiveToolNames()).toEqual(["gem_one", "gem_two"]);
		});
	});
});
