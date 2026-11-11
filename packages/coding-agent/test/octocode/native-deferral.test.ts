import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_EXPOSURE_SETTING } from "../../../mcp/src/deferral.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import { nativeToolDeferred, withNativeDeferral } from "../../src/octocode/permission/native-deferral.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const tool = (name: string) => ({
	name,
	label: name,
	description: `The ${name} tool. Second sentence.`,
	parameters: Type.Object({
		reason: Type.String(),
		op: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
		queries: Type.Optional(Type.Array(Type.Object({ url: Type.String() }))),
	}),
	execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
});
const api = (settings: object) => ({ getSettings: () => settings }) as never;
const agentDir = () => {
	const dir = tmp();
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
	return dir;
};

describe("native tool deferral", () => {
	it("defers only deferrable tools, only under recent exposure or a pin", () => {
		agentDir();
		expect(nativeToolDeferred("web", { mcpExposure: "direct" })).toBe(false);
		expect(nativeToolDeferred("web", { mcpExposure: "recent" })).toBe(true);
		expect(nativeToolDeferred("bash", { mcpExposure: "recent" })).toBe(false);
		expect(nativeToolDeferred("web", { mcpExposure: "recent", nativeToolExposure: { web: "direct" } })).toBe(false);
		expect(nativeToolDeferred("web", { mcpExposure: "direct", nativeToolExposure: { web: "deferred" } })).toBe(true);
		expect(nativeToolDeferred("bash", { nativeToolExposure: { bash: "deferred" } })).toBe(false);
	});

	it("defers web and archive by default (no mcpExposure set) until the working directory calls them", () => {
		agentDir();
		expect(SETTINGS_DEFAULTS.mcpExposure).toBe(DEFAULT_MCP_EXPOSURE_SETTING);
		expect(nativeToolDeferred("web", {})).toBe(true);
		expect(nativeToolDeferred("archive", undefined)).toBe(true);
		expect(nativeToolDeferred("bash", {})).toBe(false);
		expect(nativeToolDeferred("file", {})).toBe(false);
	});

	it("declares a deferred tool with its description, field names and the required reason, and validates in full", () => {
		agentDir();
		const full = tool("web");
		const thin = withNativeDeferral(api({ mcpExposure: "recent" }), full as never) as never as typeof full & {
			validationParameters: unknown;
			validationHint: (failure: { envelope: boolean; properties: string[] }) => string;
		};
		expect(thin.description).toBe(full.description);
		expect(thin.parameters).toEqual({
			type: "object",
			properties: { reason: { type: "string" }, op: { type: "string" }, queries: { type: "array" } },
			additionalProperties: true,
			required: ["reason"],
		});
		expect(thin.validationParameters).toBe(full.parameters);
		expect(thin.validationHint({ envelope: false, properties: ["op"] })).toContain('"op"');
		expect(withNativeDeferral(api({ mcpExposure: "direct" }), full as never).parameters).toBe(full.parameters);
		expect(
			withNativeDeferral(api({ mcpExposure: "recent" }), tool("bash") as never).validationParameters,
		).toBeUndefined();
	});

	it("records a call, so the next session declares the tool in full; a subagent takes its parent's set", async () => {
		const dir = agentDir();
		const settings = { mcpExposure: "recent" };
		const first = withNativeDeferral(api(settings), tool("web") as never);
		await first.execute("id", { reason: "r", op: "search" }, undefined, undefined, {} as never);
		expect(Object.values(JSON.parse(fs.readFileSync(path.join(dir, "tool-use.json"), "utf8")))[0]).toHaveProperty(
			"native/web",
		);
		expect(nativeToolDeferred("web", settings)).toBe(false);
		expect(nativeToolDeferred("archive", settings)).toBe(true);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP_RECENT_TOOLS", JSON.stringify(["native/archive"]));
		expect(nativeToolDeferred("web", settings)).toBe(true);
		expect(nativeToolDeferred("archive", settings)).toBe(false);
	});
});
