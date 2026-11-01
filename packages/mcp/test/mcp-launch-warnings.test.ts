import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigValueOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { hostPaths, installMcpHost, type McpPathsPort } from "../src/host.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { presetEntries } from "../src/preset.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const original = hostPaths();
const withRoots = (researchRoots: McpPathsPort["researchRoots"]) =>
	installMcpHost({ paths: { ...original, researchRoots } });
afterEach(() => installMcpHost({ paths: original }));

const allowed = (): string[] => {
	const preset = octocodePreset(() => ["/skills/one"], {});
	const prepared = preset.prepareLaunch!(presetEntries([preset])[0], "/work/app", true);
	const env = (prepared.config as { env: Record<string, string> }).env;
	return resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS").split(",");
};

describe("the user's roots reach the launch only through the host port", () => {
	it("a standalone host without the port keeps the automatic roots", () => {
		withRoots(undefined);
		expect(allowed()).toEqual(["/work/app", original.sessionsRoot({}), "/skills/one"]);
	});

	it("appends the port's roots after the automatic ones and passes the process environment", () => {
		const seen: Array<NodeJS.ProcessEnv | undefined> = [];
		withRoots((env) => {
			seen.push(env);
			return { roots: ["/user/a", "/skills/one"], warnings: [] };
		});
		expect(allowed()).toEqual(["/work/app", original.sessionsRoot({}), "/skills/one", "/user/a"]);
		expect(seen).toEqual([{}]);
	});

	it("queues the port's warnings once on the preset and shows them at the next prompt", async () => {
		const warning = `Allowed folder "rel" from the test ${Math.random()} is not an absolute path; ignored.`;
		withRoots(() => ({ roots: [], warnings: [warning] }));
		const preset = octocodePreset(() => [], {});
		const entry = presetEntries([preset])[0];
		preset.prepareLaunch!(entry, "/work/app", true);
		preset.prepareLaunch!(entry, "/work/app", true);
		expect(preset.takeWarnings!()).toEqual([warning]);
		expect(preset.takeWarnings!()).toEqual([]);

		const another = `${warning} again`;
		withRoots(() => ({ roots: [], warnings: [another] }));
		const host = mcpHost({ servers: [], presets: [octocodePreset(() => [], {})] });
		octocodePreset(() => [], {}).prepareLaunch!(entry, "/work/app", true);
		await host.start();
		await host.prompt();
		expect(host.ctx.ui.notes).toContainEqual({ message: another, type: "warning" });
		await host.close();
	});
});
