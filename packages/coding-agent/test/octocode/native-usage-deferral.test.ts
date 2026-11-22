import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_FILE_NAME, UsageRecorder, usageCounts } from "@octocodeai/octocode-common/usage-counts";
import {
	nativeToolDeferred,
	settleNativeDeferral,
	withNativeDeferral,
} from "../../src/octocode/permission/native-deferral.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** `declaring` main sessions declare `native/<name>`; the first `callers` call it. */
function seed(dir: string, name: string, declaring: number, callers: number): void {
	for (let i = 0; i < declaring; i++) {
		const recorder = new UsageRecorder(
			() => path.join(dir, USAGE_FILE_NAME),
			() => "main",
		);
		recorder.record("declared", [`native/${name}`]);
		if (i < callers) recorder.record("called", [`native/${name}`]);
	}
}

describe("native tools under mcpExposure usage", () => {
	it("defers every deferrable tool with no usage data, memory and timer included", () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
		for (const name of ["web", "archive", "models", "backlogPlan", "memory", "notify"])
			expect(nativeToolDeferred(name, { mcpExposure: "usage" }, {})).toBe(true);
		expect(nativeToolDeferred("bash", { mcpExposure: "usage" }, {})).toBe(false);
	});

	it("declares even the tools the snapshot names thin, and a pin wins either way", () => {
		const dir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
		seed(dir, "web", 20, 2);
		seed(dir, "memory", 19, 19);
		const settings = { mcpExposure: "usage" };
		expect(nativeToolDeferred("web", settings, {})).toBe(true);
		expect(nativeToolDeferred("memory", settings, {})).toBe(true);
		expect(nativeToolDeferred("web", { ...settings, nativeToolExposure: { web: "deferred" } }, {})).toBe(true);
		expect(nativeToolDeferred("notify", { ...settings, nativeToolExposure: { notify: "direct" } }, {})).toBe(false);
	});

	it("leaves memory and timer in full under recent, direct and deferred unless pinned", () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
		for (const mcpExposure of ["recent", "direct", "deferred"]) {
			expect(nativeToolDeferred("memory", { mcpExposure }, {})).toBe(false);
			expect(nativeToolDeferred("notify", { mcpExposure }, {})).toBe(false);
		}
		expect(
			nativeToolDeferred("memory", { mcpExposure: "recent", nativeToolExposure: { memory: "deferred" } }, {}),
		).toBe(true);
	});
});

describe("native on-demand tools under mcpExposure usage, at session start", () => {
	/** A model whose transport adds a declaration after the cached prefix, so the on-demand tier applies. */
	const CAPABLE = {
		api: "anthropic-messages",
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
	};
	const tool = (name: string) => ({
		name,
		label: name,
		description: `The ${name} tool.`,
		parameters: Type.Object({ reason: Type.String(), op: Type.Union([Type.Literal("a"), Type.Literal("b")]) }),
		execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
	});
	/** A session that registers `names` with `active` selected, and settles their declarations. */
	function start(names: string[], active: string[]) {
		const registered = new Map<string, { onDemand?: boolean; parameters: { additionalProperties?: unknown } }>();
		let on = [...active];
		const api = {
			settings: { get: () => ({ mcpExposure: "usage" }) },
			tools: {
				register: (definition: { name: string; onDemand?: boolean; parameters: never }) =>
					registered.set(definition.name, definition),
				getActive: () => on,
				setActive: (next: string[]) => (on = [...next]),
				selects: () => true,
			},
		};
		for (const name of names) registered.set(name, withNativeDeferral(api as never, tool(name) as never) as never);
		settleNativeDeferral(
			api as never,
			{
				model: CAPABLE,
				sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			} as never,
		);
		return { registered, active: () => on };
	}

	it("declares a promoted on-demand tool thin from the start, leaves the rest on demand, and counts what it offers", () => {
		const dir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
		seed(dir, "archive", 20, 20);
		const s = start(["archive", "models", "web", "backlogPlan"], ["mcp", "archive", "models", "web"]);
		expect(s.registered.get("archive")).toMatchObject({ parameters: { additionalProperties: true } });
		expect(s.registered.get("archive")?.onDemand).toBeUndefined();
		expect(s.active()).toContain("archive");
		expect(s.registered.get("models")?.onDemand).toBe(true);
		expect(s.active()).not.toContain("models");
		expect(s.registered.get("web")).toMatchObject({ parameters: { additionalProperties: true } });
		// backlogPlan is outside this session's selection: neither declared nor listed, so it is not counted.
		const counts = usageCounts(path.join(dir, USAGE_FILE_NAME), "main");
		expect(counts["native/archive"]?.declared).toBe(21);
		expect(counts["native/models"]?.declared).toBe(1);
		expect(counts["native/web"]?.declared).toBe(1);
		expect(counts["native/backlogPlan"]).toBeUndefined();
		// What promoting each on-demand tool would add: its thin declaration.
		const sizes = JSON.parse(fs.readFileSync(path.join(dir, USAGE_FILE_NAME), "utf8")).sizes.main;
		expect(Object.keys(sizes).sort()).toEqual(["native/archive", "native/models"]);
	});

	it("leaves memory on demand in a subagent", () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		const s = start(["memory"], ["mcp", "memory"]);
		expect(s.registered.get("memory")?.onDemand).toBe(true);
		expect(s.active()).not.toContain("memory");
	});
});
