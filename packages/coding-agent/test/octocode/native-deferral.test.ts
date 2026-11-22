import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_EXPOSURE_SETTING } from "../../../mcp/src/deferral.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import {
	nativeToolDeferred,
	settleNativeDeferral,
	withNativeDeferral,
} from "../../src/octocode/permission/native-deferral.ts";
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
const api = (settings: object) => ({ settings: { get: () => settings } }) as never;
const agentDir = () => {
	const dir = tmp();
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
	return dir;
};

describe("native tool deferral", () => {
	it("defers only deferrable tools, only under recent exposure or a pin", () => {
		agentDir();
		expect(nativeToolDeferred("backlogPlan", { mcpExposure: "direct" })).toBe(false);
		expect(nativeToolDeferred("backlogPlan", { mcpExposure: "recent" })).toBe(true);
		expect(nativeToolDeferred("bash", { mcpExposure: "recent" })).toBe(false);
		expect(
			nativeToolDeferred("backlogPlan", { mcpExposure: "recent", nativeToolExposure: { backlogPlan: "direct" } }),
		).toBe(false);
		expect(
			nativeToolDeferred("backlogPlan", { mcpExposure: "direct", nativeToolExposure: { backlogPlan: "deferred" } }),
		).toBe(true);
		expect(nativeToolDeferred("bash", { nativeToolExposure: { bash: "deferred" } })).toBe(false);
	});

	it("never defers web, the core fetch tool: not under any exposure, and a pin naming it is ignored", () => {
		agentDir();
		for (const mcpExposure of ["usage", "recent", "direct", "deferred", undefined]) {
			expect(nativeToolDeferred("web", { mcpExposure })).toBe(false);
			expect(nativeToolDeferred("web", { mcpExposure, nativeToolExposure: { web: "deferred" } })).toBe(false);
		}
		const full = tool("web");
		expect(
			withNativeDeferral(api({ mcpExposure: "usage", nativeToolExposure: { web: "deferred" } }), full as never),
		).toBe(full);
	});

	it("defers backlogPlan and archive by default (no mcpExposure set) until the working directory calls them", () => {
		agentDir();
		expect(SETTINGS_DEFAULTS.mcpExposure).toBe(DEFAULT_MCP_EXPOSURE_SETTING);
		expect(nativeToolDeferred("backlogPlan", {})).toBe(true);
		expect(nativeToolDeferred("archive", undefined)).toBe(true);
		expect(nativeToolDeferred("bash", {})).toBe(false);
		expect(nativeToolDeferred("file", {})).toBe(false);
	});

	it("declares a deferred tool with its description, field types, allowed values and required fields, and validates in full", () => {
		agentDir();
		const full = tool("backlogPlan");
		const thin = withNativeDeferral(api({ mcpExposure: "recent" }), full as never) as never as typeof full & {
			validationParameters: unknown;
			validationHint: (failure: { envelope: boolean; properties: string[] }) => string;
		};
		expect(thin.description).toBe(full.description);
		expect(thin.parameters).toEqual({
			type: "object",
			properties: {
				reason: { type: "string" },
				op: { type: "string", enum: ["search", "fetch"] },
				queries: { type: "array" },
			},
			additionalProperties: true,
			required: ["reason", "op"],
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
		const first = withNativeDeferral(api(settings), tool("backlogPlan") as never);
		await first.execute("id", { reason: "r", op: "search" }, undefined, undefined, {} as never);
		expect(Object.values(JSON.parse(fs.readFileSync(path.join(dir, "tool-use.json"), "utf8")))[0]).toHaveProperty(
			"native/backlogPlan",
		);
		expect(nativeToolDeferred("backlogPlan", settings)).toBe(false);
		expect(nativeToolDeferred("archive", settings)).toBe(true);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP_RECENT_TOOLS", JSON.stringify(["native/archive"]));
		expect(nativeToolDeferred("backlogPlan", settings)).toBe(true);
		expect(nativeToolDeferred("archive", settings)).toBe(false);
	});

	describe("settled when the session starts", () => {
		/** An API whose settings read only after load, and the declarations a session's transcript holds. */
		function host(settings: object | undefined) {
			const registered: Array<{ name: string; parameters: unknown }> = [];
			const loaded = {
				settings: {
					get: () => {
						if (!settings) throw new Error("not initialized");
						return settings;
					},
				},
				tools: { register: (definition: { name: string; parameters: unknown }) => registered.push(definition) },
			};
			const ctx = (declared: Array<{ name: string; parameters: unknown }> | Error) => ({
				sessionManager: {
					buildSessionProjection: () => {
						if (declared instanceof Error) throw declared;
						return {
							messages: [{ role: "system", content: "", toolsAdded: declared, timestamp: 0 }],
						};
					},
				},
			});
			return { api: loaded, registered, ctx };
		}
		const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

		it("declares a tool as the transcript declared it, in place, and fails open on anything else", () => {
			agentDir();
			const at = host(undefined);
			const plan = withNativeDeferral(at.api as never, tool("backlogPlan") as never);
			const full = tool("backlogPlan");
			// Registered deferred (nothing called it); the session declared it direct before.
			expect(plan.validationParameters).toBeDefined();
			settleNativeDeferral(
				at.api as never,
				at.ctx([{ name: "backlogPlan", parameters: json(full.parameters) }]) as never,
			);
			expect(at.registered.map((definition) => definition.name)).toEqual(["backlogPlan"]);
			expect(json(at.registered[0].parameters)).toEqual(json(full.parameters));

			// The transcript holds the form now registered, a form neither declaration has, or cannot be read: nothing changes.
			for (const declared of [
				[{ name: "backlogPlan", parameters: json(plan.parameters) }],
				[{ name: "backlogPlan", parameters: { type: "object", properties: { other: { type: "string" } } } }],
				[],
				new Error("unreadable"),
			]) {
				const again = host(undefined);
				withNativeDeferral(again.api as never, tool("backlogPlan") as never);
				settleNativeDeferral(again.api as never, again.ctx(declared) as never);
				expect(again.registered).toEqual([]);
			}
		});

		it("lets a pin or a setting other than recent win over the transcript", () => {
			agentDir();
			const settings: { current: object | undefined } = { current: undefined };
			const at = host(undefined);
			const api = { ...at.api, settings: { get: () => settings.current ?? at.api.settings.get() } };
			withNativeDeferral(api as never, tool("backlogPlan") as never);
			withNativeDeferral(api as never, tool("archive") as never);
			// Registered deferred; the session declared both direct; `backlogPlan` is pinned deferred, the setting is not `recent`.
			settings.current = { mcpExposure: "direct", nativeToolExposure: { backlogPlan: "deferred" } };
			const declared = ["backlogPlan", "archive"].map((name) => ({ name, parameters: json(tool(name).parameters) }));
			settleNativeDeferral(api as never, at.ctx(declared) as never);
			expect(at.registered.map((definition) => definition.name)).toEqual(["archive"]);
			expect(json(at.registered[0].parameters)).toEqual(json(tool("archive").parameters));
		});
	});
});
