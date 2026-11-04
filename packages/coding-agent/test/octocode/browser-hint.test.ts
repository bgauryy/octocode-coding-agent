import { describe, expect, it } from "vitest";
import { toolHint } from "../../src/octocode/shared/util.ts";

describe("browser activity hints", () => {
	it("names a run by its plan steps and never by typed values", () => {
		expect(
			toolHint({
				plan: {
					steps: [
						{ op: "goto", url: "https://example.com" },
						{ op: "act", action: "click", ref: "e4" },
						{ op: "act", action: "type", ref: "e5", value: "hunter2" },
						{ op: "extract" },
					],
				},
			}),
		).toBe("goto → click e4 → type e5 → extract");
		expect(toolHint({ step: { op: "act", action: "click", ref: "e1" } })).toBe("click e1");
	});

	it("names cdp, open, recipe and target calls", () => {
		expect(toolHint({ method: "Page.captureScreenshot", params: { quality: 1 } })).toBe("Page.captureScreenshot");
		expect(toolHint({ url: "https://example.com", headless: true })).toBe("https://example.com (headless)");
		expect(toolHint({ url: "https://example.com", headless: false })).toBe("https://example.com");
		expect(toolHint({ recipe: "dom-operations-check" })).toBe("dom-operations-check");
		expect(toolHint({ selector: "#main" })).toBe("#main");
	});

	it("says nothing for an empty plan and clips a long one", () => {
		expect(toolHint({ plan: { steps: [] } })).toBe("");
		const long = Array.from({ length: 30 }, () => ({ op: "snapshot" }));
		expect(toolHint({ plan: { steps: long } }).length).toBeLessThanOrEqual(80);
	});
});
