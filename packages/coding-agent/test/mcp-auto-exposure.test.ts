import type { Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { prefersDeferred, resolveMcpExposure } from "../src/extensions/mcp/exposure.ts";

const model = (compat: Record<string, boolean | undefined> = {}) => ({ contextWindow: 1000, compat }) as Model<any>;
const small = [{ name: "read", inputSchema: { type: "object" as const } }];
const large = [{ ...small[0], description: "x".repeat(500) }];

describe("automatic MCP exposure", () => {
	it("budgets combined catalogs against input space after the output reserve", () => {
		const selected = { ...model({ supportsToolSearch: true }), contextWindow: 1000, maxTokens: 500 };
		expect(resolveMcpExposure("auto", small, selected, true)).toBe("direct");
		expect(resolveMcpExposure("auto", [...small, ...small, ...small, ...small, ...small], selected, true)).toBe(
			"deferred",
		);
		expect(resolveMcpExposure("direct", large, selected, true)).toBe("direct");
	});
	it("uses direct calls for small catalogs even when deferred loading is supported", () => {
		expect(resolveMcpExposure("auto", small, model({ supportsToolSearch: true }), true)).toBe("direct");
	});
	it.each([
		{ supportsToolSearch: true },
		{ supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
		{ supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	])("defers large catalogs only with supported native loading: %j", (compat) => {
		expect(resolveMcpExposure("auto", large, model(compat), true)).toBe("deferred");
	});
	it("falls back to direct tools without native loading, discovery, or a selected model", () => {
		expect(resolveMcpExposure("auto", large, model(), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model({ supportsAdditionalTools: true }), true)).toBe("direct");
		expect(resolveMcpExposure("auto", large, model({ supportsToolSearch: true }), false)).toBe("direct");
		expect(resolveMcpExposure("auto", large, undefined, true)).toBe("direct");
	});
	it.each(["direct", "deferred", "hidden"] as const)("preserves explicit %s exposure", (exposure) => {
		expect(resolveMcpExposure(exposure, large, model(), false)).toBe(exposure);
		expect(resolveMcpExposure(exposure, small, model(), true, true)).toBe(exposure);
	});
	it("defers a preferring server's small catalog whenever discovery is available, with or without native loading", () => {
		expect(resolveMcpExposure("auto", small, model(), true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", small, undefined, true, true)).toBe("deferred");
		expect(resolveMcpExposure("auto", small, model({ supportsToolSearch: true }), false, true)).toBe("direct");
	});
	it("prefers discovery only for the octocode server without its own exposure", () => {
		expect(prefersDeferred("octocode", {})).toBe(true);
		expect(prefersDeferred("octocode", { exposure: "direct" })).toBe(false);
		expect(prefersDeferred("octocode", { exposure: "auto" })).toBe(false);
		expect(prefersDeferred("docs", {})).toBe(false);
	});
});
