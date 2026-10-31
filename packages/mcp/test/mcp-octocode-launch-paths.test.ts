import { describe, expect, it } from "vitest";
import { resolveConfigValueOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { presetEntries } from "../src/preset.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { literalConfigValue } from "../src/presets/octocode/literal.ts";
import { prepareOctocodeSkillLaunch } from "../src/presets/octocode/skill-paths.ts";
import { createDefaultTransport } from "../src/runtime.ts";

const PATHS = ["/Users/me/code/$work/proj", "/srv/$$x", "/a/${HOME}/b", "/a/$!/b", "!/odd/start"];

describe("workspace paths in the built-in research server's environment", () => {
	it.each(PATHS)("%s survives value resolution unchanged", (path) => {
		expect(resolveConfigValueOrThrow(literalConfigValue(path), "path")).toBe(path);
	});

	it.each(PATHS)("starts the default server in %s", (cwd) => {
		const preset = octocodePreset(() => ["/skills/$one"], {});
		const [entry] = presetEntries([preset]);
		const prepared = preset.prepareLaunch!(entry, cwd, true);
		const env = (prepared.config as { env: Record<string, string> }).env;
		expect(() => createDefaultTransport(prepared, cwd, undefined)).not.toThrow();
		expect(resolveConfigValueOrThrow(env.WORKSPACE_ROOT, "WORKSPACE_ROOT")).toBe(cwd);
		const allowed = resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS").split(",");
		expect(allowed).toContain(cwd);
		expect(allowed).toContain("/skills/$one");
	});

	it("escapes the roots it supplies to a configured local server, and leaves the user's own env values alone", () => {
		const cwd = "/Users/me/$work";
		const entry = {
			name: "octocode",
			source: "test",
			config: { command: "octocode-mcp", env: { TOKEN: "${GH_TOKEN}" } },
		};
		const prepared = prepareOctocodeSkillLaunch(entry, cwd, ["/skills/$a"], {});
		const env = (prepared.config as { env: Record<string, string> }).env;
		expect(env.TOKEN).toBe("${GH_TOKEN}");
		expect(resolveConfigValueOrThrow(env.WORKSPACE_ROOT, "WORKSPACE_ROOT")).toBe(cwd);
		expect(resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS")).toContain("/skills/$a");
	});
});
