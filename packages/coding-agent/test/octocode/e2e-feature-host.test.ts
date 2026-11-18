import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { FeatureSetup } from "../../src/core/features/index.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * The feature host through the resource loader, the entry every session (terminal, RPC, ACP, print) registers its
 * features by. These replace the deleted loader tests: a duplicate id names both owners, and built-ins switch on and off.
 */
async function load(
	options: Partial<DefaultResourceLoaderOptions> & { settings?: Record<string, unknown>; trusted?: boolean } = {},
) {
	const root = fs.realpathSync(tmp("octocode-feature-host-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const { settings, trusted, ...loaderOptions } = options;
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...settings });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...loaderOptions,
	});
	await loader.reload();
	return { loader, cwd, agentDir, result: loader.getFeatures() };
}

const tool = (name: string) => (api: FeatureSetup) =>
	api.tools.register({
		name,
		label: name,
		description: "Entry-point fixture tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});

const ids = (result: { features: Array<{ id: string }> }) => result.features.map((feature) => feature.id);

describe("duplicate registrations", () => {
	it("names both features when two register the same tool, and keeps the first", async () => {
		const { result } = await load({
			features: testFeatures([
				{ name: "first", factory: tool("shared") },
				{ name: "second", factory: tool("shared") },
			]),
		});
		expect(result.errors).toEqual([
			{
				path: "<inline:second>",
				error: 'Tool "shared" registered by <inline:second> (builtin) conflicts with <inline:first> (builtin)',
			},
		]);
		const owners = result.features.filter((feature) => feature.tools.has("shared")).map((feature) => feature.id);
		expect(owners).toContain("first");
	});

	it("names the native owner when a feature takes a native tool name", async () => {
		const { result } = await load({ features: testFeatures([{ name: "thief", factory: tool("archive") }]) });
		const conflict = result.errors.find((error) => error.error.includes('Tool "archive"'));
		expect(conflict?.error).toMatch(
			/^Tool "archive" registered by <inline:thief> \(builtin\) conflicts with .* \(native\)$/,
		);
	});

	it("reports a feature whose registration throws and registers the rest", async () => {
		const { result } = await load({
			features: testFeatures([
				{
					name: "broken",
					factory: () => {
						throw new Error("boom");
					},
				},
				{ name: "fine", factory: tool("fine_tool") },
			]),
		});
		expect(result.errors).toEqual([{ path: "<inline:broken>", error: expect.stringContaining("boom") }]);
		expect(ids(result)).toContain("fine");
	});
});

describe("built-in features", () => {
	it("registers the native feature set and every built-in by default", async () => {
		const { result } = await load();
		expect(result.errors).toEqual([]);
		expect(ids(result)).toEqual(["mcp", "octocode"]);
		expect(Object.fromEntries(result.features.map((feature) => [feature.id, feature.owner]))).toEqual({
			mcp: "builtin",
			octocode: "native",
		});
	});

	it("keeps MCP on when settings name -builtin:mcp: MCP is core, switched only by MCP configuration or --no-mcp", async () => {
		const { result } = await load({ settings: { extensions: ["-builtin:mcp"] } });
		expect(result.errors).toEqual([]);
		expect(ids(result)).toEqual(["mcp", "octocode"]);
	});

	it("switches MCP off with disabledFeatures (--no-mcp) and keeps the native set", async () => {
		const { result } = await load({ disabledFeatures: ["mcp"] });
		expect(result.errors).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		expect(ids(result)).toEqual(["octocode"]);
	});

	it("registers only the features a host supplies", async () => {
		const { result } = await load({
			nativeFeatures: undefined,
			features: testFeatures([{ name: "host", factory: tool("host_tool") }]),
		});
		expect(ids(result)).toEqual(["host"]);
	});
});

describe("code files in the old extensions setting and directories", () => {
	it("never imports a code file named in the old extensions setting", async () => {
		const root = fs.realpathSync(tmp("octocode-feature-host-code-"));
		const ran = path.join(root, "ran.txt");
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(
			file,
			`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "x"); export default () => {};`,
		);
		const { result } = await load({ settings: { extensions: [file] } });
		expect(result.warnings ?? []).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(fs.existsSync(ran)).toBe(false);
	});

	/** Real settings storage: a user extension directory, a project one, and a code file in each. */
	async function discover(projectTrusted: boolean) {
		const root = fs.realpathSync(tmp("octocode-feature-host-discovery-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const userFile = path.join(agentDir, "extensions", "user-ext.ts");
		const projectFile = path.join(cwd, ".octocode", "extensions", "project-ext.ts");
		const ran = path.join(root, "ran.txt");
		for (const file of [userFile, projectFile]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				`import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(ran)}, "x"); export default () => {};`,
			);
		}
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getFeatures();
		return { result, userFile, projectFile, ran };
	}

	it.each([true, false])(
		"runs no code file in the user or project extensions directories (project trusted: %s)",
		async (trusted) => {
			const { result, ran } = await discover(trusted);
			expect(result.warnings ?? []).toEqual([]);
			expect(result.errors).toEqual([]);
			expect(ids(result)).toEqual(["mcp", "octocode"]);
			expect(fs.existsSync(ran)).toBe(false);
		},
	);
});
