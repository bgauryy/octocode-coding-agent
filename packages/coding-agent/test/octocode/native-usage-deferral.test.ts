import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_FILE_NAME, UsageRecorder } from "../../../common/src/usage-counts.ts";
import { nativeToolDeferred } from "../../src/octocode/permission/native-deferral.ts";
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
		for (const name of ["web", "archive", "models", "backlogPlan", "memory", "timer"])
			expect(nativeToolDeferred(name, { mcpExposure: "usage" }, {})).toBe(true);
		expect(nativeToolDeferred("bash", { mcpExposure: "usage" }, {})).toBe(false);
	});

	it("declares in full the tools the snapshot names, and a pin wins either way", () => {
		const dir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
		seed(dir, "web", 20, 2);
		seed(dir, "memory", 19, 19);
		const settings = { mcpExposure: "usage" };
		expect(nativeToolDeferred("web", settings, {})).toBe(false);
		expect(nativeToolDeferred("memory", settings, {})).toBe(true);
		expect(nativeToolDeferred("web", { ...settings, nativeToolExposure: { web: "deferred" } }, {})).toBe(true);
		expect(nativeToolDeferred("timer", { ...settings, nativeToolExposure: { timer: "direct" } }, {})).toBe(false);
	});

	it("leaves memory and timer in full under recent, direct and deferred unless pinned", () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
		for (const mcpExposure of ["recent", "direct", "deferred"]) {
			expect(nativeToolDeferred("memory", { mcpExposure }, {})).toBe(false);
			expect(nativeToolDeferred("timer", { mcpExposure }, {})).toBe(false);
		}
		expect(
			nativeToolDeferred("memory", { mcpExposure: "recent", nativeToolExposure: { memory: "deferred" } }, {}),
		).toBe(true);
	});
});
