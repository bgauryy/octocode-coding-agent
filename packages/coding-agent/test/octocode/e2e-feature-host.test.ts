import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { tmp } from "./helpers.ts";

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
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...loaderOptions,
	});
	await loader.reload();
	return { loader, cwd, agentDir, result: loader.getExtensions() };
}

const tool = (name: string) => (api: ExtensionAPI) =>
	api.registerTool({
		name,
		label: name,
		description: "Entry-point fixture tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});

const ids = (result: { extensions: Array<{ id: string }> }) => result.extensions.map((extension) => extension.id);

describe("duplicate registrations", () => {
	it("names both features when two register the same tool, and keeps the first", async () => {
		const { result } = await load({
			extensionFactories: [
				{ name: "first", factory: tool("shared") },
				{ name: "second", factory: tool("shared") },
			],
		});
		expect(result.errors).toEqual([
			{
				path: "<inline:second>",
				error: 'Tool "shared" registered by <inline:second> (builtin) conflicts with <inline:first> (builtin)',
			},
		]);
		const owners = result.extensions
			.filter((extension) => extension.tools.has("shared"))
			.map((extension) => extension.id);
		expect(owners).toContain("first");
	});

	it("names the native owner when a feature takes a native tool name", async () => {
		const { result } = await load({ extensionFactories: [{ name: "thief", factory: tool("archive") }] });
		const conflict = result.errors.find((error) => error.error.includes('Tool "archive"'));
		expect(conflict?.error).toMatch(
			/^Tool "archive" registered by <inline:thief> \(builtin\) conflicts with .* \(native\)$/,
		);
	});

	it("reports a feature whose registration throws and registers the rest", async () => {
		const { result } = await load({
			extensionFactories: [
				{
					name: "broken",
					factory: () => {
						throw new Error("boom");
					},
				},
				{ name: "fine", factory: tool("fine_tool") },
			],
		});
		expect(result.errors).toEqual([{ path: "<inline:broken>", error: expect.stringContaining("boom") }]);
		expect(ids(result)).toContain("fine");
	});
});

describe("built-in features", () => {
	it("registers the native feature set and every built-in by default", async () => {
		const { result } = await load();
		expect(result.errors).toEqual([]);
		expect(ids(result)).toEqual(["llama.cpp", "mcp", "octocode"]);
		expect(Object.fromEntries(result.extensions.map((extension) => [extension.id, extension.owner]))).toEqual({
			"llama.cpp": "builtin",
			mcp: "builtin",
			octocode: "native",
		});
	});

	it("keeps MCP on when settings name -builtin:mcp: MCP is core, switched only by MCP configuration or --no-mcp", async () => {
		const { result } = await load({ settings: { extensions: ["-builtin:mcp"] } });
		expect(result.errors).toEqual([]);
		expect(ids(result)).toEqual(["llama.cpp", "mcp", "octocode"]);
	});

	it.each([
		{
			how: "a -builtin:llama.cpp settings entry",
			options: { settings: { extensions: ["-builtin:llama.cpp"] } },
			off: "llama.cpp",
		},
		{ how: "disabledFeatures (--no-mcp)", options: { disabledFeatures: ["mcp"] }, off: "mcp" },
	])("switches one built-in off with $how and keeps the rest", async ({ options, off }) => {
		const { result } = await load(options);
		expect(result.errors).toEqual([]);
		expect(result.warnings ?? []).toEqual([]);
		const expected = ["llama.cpp", "mcp", "octocode"].filter((id) => id !== off);
		expect(ids(result)).toEqual(expected);
	});

	it("registers only the features a host supplies", async () => {
		const { result } = await load({
			nativeFeatures: false,
			extensionFactories: [{ name: "host", factory: tool("host_tool") }],
		});
		expect(ids(result)).toEqual(["host"]);
	});
});

describe("extension files in settings and discovery directories", () => {
	it("warns for a code file named in settings and does not import it", async () => {
		const root = fs.realpathSync(tmp("octocode-feature-host-code-"));
		const ran = path.join(root, "ran.txt");
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(
			file,
			`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "x"); export default () => {};`,
		);
		const { result } = await load({ settings: { extensions: [file] } });
		expect(result.warnings).toEqual([
			{ path: file, warning: expect.stringMatching(/^Ignored extension\. .*PLUGINS\.md\)\.$/) },
		]);
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
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		return { result, userFile, projectFile, ran };
	}

	it("warns about extension files found in the user and the trusted project directories, and runs none", async () => {
		const { result, userFile, projectFile, ran } = await discover(true);
		expect((result.warnings ?? []).map((warning) => warning.path).sort()).toEqual([projectFile, userFile].sort());
		for (const warning of result.warnings ?? []) expect(warning.warning).toMatch(/^Ignored extension\./);
		expect(result.errors).toEqual([]);
		expect(fs.existsSync(ran)).toBe(false);
	});

	it("does not even list a project extension file while the project is untrusted", async () => {
		const { result, userFile, ran } = await discover(false);
		expect((result.warnings ?? []).map((warning) => warning.path)).toEqual([userFile]);
		expect(fs.existsSync(ran)).toBe(false);
	});
});
