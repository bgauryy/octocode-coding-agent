import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import { CORE_TOOLS, MCP_ACCESS_TOOLS, loadProfiles, parseProfile } from "../../src/octocode/subagents/profiles.ts";
import { LOCAL_RESEARCH_TOOLS } from "../../src/octocode/shared/octocode-tools.ts";
import { tmp } from "./helpers.ts";

const SESSION = { dir: "/tmp/session", id: "core-test" };
const profile = (frontmatter: string) => parseProfile("core", `---\n${frontmatter}\n---\nTask`);
const allowed = (tools: string | undefined) => (tools ?? "").split(",");

describe("core tools of a subagent profile", () => {
	it.each(["tools", "excludeTools"])("rejects malformed %s instead of silently enabling defaults", (field) => {
		for (const value of ["[file, bash]", "false", "12", "{ file: true }"]) {
			expect(() => profile(`${field}: ${value}`)).toThrow(`${field} must be a comma-separated string`);
		}
	});

	it("adds file, communication, history and MCP access to an allowlist, once, and passes them as --tools", () => {
		const parsed = profile("tools: edit,bash");
		expect(allowed(parsed.tools)).toEqual(["edit", "bash", "file", "agent", "archive", ...MCP_ACCESS_TOOLS, "mcp__*"]);
		const args = parseArgs(buildAgentArgs(parsed, undefined, SESSION));
		expect(args.tools).toEqual(["edit", "bash", "file", "agent", "archive", ...MCP_ACCESS_TOOLS, "mcp__*"]);
		// A name already listed is not repeated.
		expect(allowed(profile("tools: read,grep").tools)).toEqual([
			"read",
			"grep",
			"file",
			"agent",
			"archive",
			...MCP_ACCESS_TOOLS,
			"mcp__*",
		]);
		expect(CORE_TOOLS).toEqual(["file", "agent", "archive"]);
	});

	it("counts a pattern that already matches a core tool, and adds the rest", () => {
		expect(profile('tools: "*"').tools).toBe("*");
		expect(allowed(profile('tools: "agent*,file"').tools)).toEqual([
			"agent*",
			"file",
			"archive",
			...MCP_ACCESS_TOOLS,
			"mcp__*",
		]);
	});

	it("gives an empty allowlist the core tools: it still reaches its parent", () => {
		expect(allowed(profile('tools: ","').tools)).toEqual(["file", "agent", "archive", ...MCP_ACCESS_TOOLS, "mcp__*"]);
	});

	it("adds core tools with modifiers when a profile leaves its tools unspecified", () => {
		const parsed = profile("excludeTools: browser");
		expect(parsed.tools).toBeUndefined();
		expect(parseArgs(buildAgentArgs(parsed, undefined, SESSION)).tools).toEqual(
			[...CORE_TOOLS, ...MCP_ACCESS_TOOLS, ...LOCAL_RESEARCH_TOOLS].map((name) => `+${name}`),
		);
	});

	it("leaves a relative list alone: it changes the default selection, which has the core tools", () => {
		expect(profile('tools: "+powershell,-bash"').tools).toBe("+powershell,-bash");
	});

	it.each([
		["excludeTools: agent", ["agent"]],
		["excludeTools: file", ["file"]],
		["tools: -file", ["file"]],
		["excludeTools: tool_search", ["tool_search"]],
		["excludeTools: mcp", ["mcp"]],
		["excludeTools: mcp__octocode__localFetch", ["mcp__octocode__localFetch"]],
		['excludeTools: "agent,browser"', ["agent"]],
		["excludeTools: archive", ["archive"]],
		['excludeTools: "*"', [...CORE_TOOLS, ...MCP_ACCESS_TOOLS, ...LOCAL_RESEARCH_TOOLS]],
		['excludeTools: "agent*"', ["agent"]],
		['tools: "-archive"', ["archive"]],
		['tools: "edit,bash"\nexcludeTools: agent', ["agent"]],
	])("refuses %j when it loads, naming the profile and the tools", (frontmatter, names) => {
		expect(() => profile(frontmatter)).toThrow(
			`Profile "core" removes ${names.join(", ")} with excludeTools or a "-" entry in tools`,
		);
		expect(() => profile(frontmatter)).toThrow(/Remove (it|them) from the profile's excludeTools/);
	});

	it("reports a refused profile through onSkip and keeps loading the others", () => {
		const cwd = tmp();
		const dir = path.join(cwd, ".octocode", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "blind.md"), "---\nexcludeTools: agent\n---\nDo it.");
		fs.writeFileSync(path.join(dir, "fine.md"), "---\ntools: edit\n---\nDo it.");
		const skipped: string[] = [];
		const profiles = loadProfiles(cwd, tmp(), true, {}, (file, error) =>
			skipped.push(`${path.basename(file)}: ${(error as Error).message}`),
		);
		expect(profiles.has("blind")).toBe(false);
		expect(allowed(profiles.get("fine")?.tools)).toEqual([
			"edit",
			"file",
			"agent",
			"archive",
			...MCP_ACCESS_TOOLS,
			"mcp__*",
		]);
		expect(skipped).toHaveLength(1);
		expect(skipped[0]).toMatch(/^blind\.md: Profile "blind" removes agent/);
		// The bundled profiles all still load.
		for (const name of ["researcher", "reviewer", "implementer", "browser"]) expect(profiles.has(name)).toBe(true);
	});

	it("keeps the core tools active in a real Octocode session started with the profile's allowlist, and drops them without the addition", async () => {
		const cwd = tmp();
		const agentDir = path.join(cwd, "agent");
		fs.mkdirSync(agentDir);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP", "0");
		const launch = parseArgs(buildAgentArgs(profile("tools: file"), undefined, SESSION));
		const activeTools = async (tools: string | undefined) => {
			const settingsManager = SettingsManager.inMemory({
				retry: { enabled: false },
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				additionalExtensionPaths: launch.extensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: ["deferred", "deferred", "hidden"].map((exposure) => ({
					name: `mcp__octocode__${exposure}`,
					label: exposure,
					description: exposure,
					parameters: Type.Object({}),
					exposure: exposure as "deferred" | "hidden",
					execute: async () => ({ content: [], details: {} }),
				})),
				...(tools ? { tools: parseArgs(["--tools", tools]).tools! } : {}),
			});
			try {
				return session.getActiveToolNames();
			} finally {
				session.dispose();
			}
		};
		try {
			const active = await activeTools(profile("tools: file").tools);
			expect(active).toEqual(expect.arrayContaining(["file", ...CORE_TOOLS, ...MCP_ACCESS_TOOLS]));
			for (const exposure of ["deferred", "deferred", "hidden"])
				expect(active).not.toContain(`mcp__octocode__${exposure}`);
			// The evidence for the addition: the bare allowlist loses the messaging tools.
			expect(await activeTools("file")).not.toContain("agent");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("a project profile that replaces an earlier one", () => {
	it("is reported, with the file and what it replaced; user-level overrides stay quiet", () => {
		const root = fs.realpathSync(tmp());
		const home = tmp();
		const body = (name: string) => `---\nname: ${name}\n---\nPrompt`;
		fs.mkdirSync(path.join(root, ".git"));
		fs.mkdirSync(path.join(root, ".octocode", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, ".octocode", "agents", "reviewer.md"), body("reviewer"));
		fs.writeFileSync(path.join(root, ".octocode", "agents", "mine.md"), body("mine"));
		const shadowed: Array<[string, string, string]> = [];
		const profiles = loadProfiles(root, home, true, {}, undefined, (name, file, replaced) =>
			shadowed.push([name, file, replaced]),
		);
		expect(profiles.get("reviewer")?.prompt).toBe("Prompt");
		expect(shadowed).toEqual([["reviewer", path.join(root, ".octocode", "agents", "reviewer.md"), "bundled"]]);
		const quiet: string[] = [];
		loadProfiles(root, home, false, {}, undefined, (name) => quiet.push(name));
		expect(quiet).toEqual([]);
	});
});
