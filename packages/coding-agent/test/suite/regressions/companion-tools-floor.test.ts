import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { FeatureRegister } from "../../../src/core/features/index.ts";
import { createHarness } from "../harness.ts";
import { testFeatures } from "../../helpers/features.ts";

/**
 * A native or base tool's `companionTools` are a floor: whenever it is active they are registered and active too,
 * whatever `--tools` or a deselection say (the native agent tool keeps `timer`, so a delegating session keeps the waiting
 * rules). The operator's `--exclude-tools` still wins, as it does over a subagent's floor. Without the lead tool the
 * companion follows the selection as usual. An extension tool's `companionTools` never get past `--tools`.
 */
describe("companion tools floor", () => {
	const tool = (name: string, extra: Record<string, unknown> = {}) => ({
		name,
		label: name,
		description: `${name} tool`,
		promptSnippet: `Run ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		...extra,
	});
	const factories: FeatureRegister[] = [
		(api) => {
			api.bus.on("session_start", () => {
				api.tools.register(tool("lead", { companionTools: ["helper"] }));
				api.tools.register(tool("helper"));
				api.tools.register(tool("other"));
			});
		},
	];

	it("keeps the companion active under an allowlist that names only the lead", async () => {
		const harness = await createHarness({ allowedToolNames: ["lead"], builtinCompactionFactories: factories });
		try {
			await harness.session.bindFeatures({});
			expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["lead", "helper"]));
			expect(harness.session.systemPrompt).toContain("- helper: Run helper");
		} finally {
			harness.cleanup();
		}
	});

	it("does not let an extension tool's companions past an allowlist that names only the lead", async () => {
		const harness = await createHarness({ allowedToolNames: ["lead"], features: testFeatures(factories) });
		try {
			await harness.session.bindFeatures({});
			expect(harness.session.getActiveToolNames()).toContain("lead");
			expect(harness.session.getActiveToolNames()).not.toContain("helper");
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("helper");
			expect(harness.session.systemPrompt).not.toContain("- helper: Run helper");
		} finally {
			harness.cleanup();
		}
	});

	it("does not let an extension tool's companions survive a deselection", async () => {
		const harness = await createHarness({ features: testFeatures(factories) });
		try {
			await harness.session.bindFeatures({});
			harness.session.setActiveToolsByName(["lead", "other"]);
			expect(harness.session.getActiveToolNames().sort()).toEqual(["lead", "other"]);
		} finally {
			harness.cleanup();
		}
	});

	it("lets the operator's exclusion of the companion win", async () => {
		const harness = await createHarness({ excludedToolNames: ["helper"], builtinCompactionFactories: factories });
		try {
			await harness.session.bindFeatures({});
			expect(harness.session.getActiveToolNames()).toContain("lead");
			expect(harness.session.getActiveToolNames()).not.toContain("helper");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the companion through a deselection while the lead stays, and lets it go with the lead", async () => {
		const harness = await createHarness({ builtinCompactionFactories: factories });
		try {
			await harness.session.bindFeatures({});
			harness.session.setActiveToolsByName(["lead", "other"]);
			expect(harness.session.getActiveToolNames().sort()).toEqual(["helper", "lead", "other"]);
			harness.session.setActiveToolsByName(["other"]);
			expect(harness.session.getActiveToolNames()).toEqual(["other"]);
		} finally {
			harness.cleanup();
		}
	});
});
