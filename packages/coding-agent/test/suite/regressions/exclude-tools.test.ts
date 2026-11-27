import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { FeatureRegister } from "../../../src/core/features/index.ts";
import { createHarness } from "../harness.ts";
import { testFeatures } from "../../helpers/features.ts";

function toolNames(tools: Array<{ name: string }>): string[] {
	return tools.map((tool) => tool.name).sort();
}

describe("exclude tools", () => {
	const factories: FeatureRegister[] = [
		(api) => {
			api.bus.on("session_start", () => {
				api.tools.register({
					name: "ask_question",
					label: "Ask Question",
					description: "Ask a question",
					promptSnippet: "Ask a question",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
				api.tools.register({
					name: "dynamic_tool",
					label: "Dynamic Tool",
					description: "Dynamic test tool",
					promptSnippet: "Run dynamic test behavior",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
			});
		},
	];

	it("filters built-in and extension tools from available and active tools", async () => {
		const harness = await createHarness({
			excludedToolNames: ["bash", "ask_question"],
			features: testFeatures(factories),
		});
		try {
			await harness.session.bindFeatures({});

			const allToolNames = toolNames(harness.session.getAllTools());
			expect(allToolNames).not.toContain("bash");
			expect(allToolNames).not.toContain("ask_question");
			expect(allToolNames).toContain("dynamic_tool");
			expect(harness.session.getActiveToolNames().sort()).toEqual(["dynamic_tool"]);
			expect(harness.session.systemPrompt).not.toContain("- bash:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
			expect(harness.session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		} finally {
			harness.cleanup();
		}
	});

	it("lets excluded tools override the allowlist", async () => {
		const harness = await createHarness({
			allowedToolNames: ["bash", "dynamic_tool", "ask_question"],
			excludedToolNames: ["bash", "ask_question"],
			initialActiveToolNames: ["bash", "dynamic_tool", "ask_question"],
			features: testFeatures(factories),
		});
		try {
			await harness.session.bindFeatures({});

			expect(toolNames(harness.session.getAllTools())).toEqual(["dynamic_tool"]);
			expect(harness.session.getActiveToolNames()).toEqual(["dynamic_tool"]);
			expect(harness.session.systemPrompt).toContain("- dynamic_tool:");
			expect(harness.session.systemPrompt).not.toContain("- bash:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
		} finally {
			harness.cleanup();
		}
	});

	it("matches allowlist and denylist patterns", async () => {
		const harness = await createHarness({
			allowedToolNames: ["*_tool", "ask_*", "ba*"],
			excludedToolNames: ["ask*"],
			initialActiveToolNames: ["*_tool", "ask_*", "ba*"],
			features: testFeatures(factories),
		});
		try {
			await harness.session.bindFeatures({});

			// Patterns that match a tool activate it like its name.
			expect(toolNames(harness.session.getAllTools())).toEqual(["bash", "dynamic_tool"]);
			expect(harness.session.getActiveToolNames().sort()).toEqual(["bash", "dynamic_tool"]);
		} finally {
			harness.cleanup();
		}
	});
});
