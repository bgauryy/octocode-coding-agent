import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { translateAgentFields } from "../../src/core/plugin-agent-fields.ts";
import { pluginAgentName } from "../../src/core/plugin-agents.ts";
import { discoverPluginComponents } from "../../src/core/plugin-components.ts";
import { loadConfiguredPluginAgents } from "../../src/core/plugin-resources.ts";
import { discoverPluginManifests } from "../../src/core/plugin-manifest.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

const REVIEWER = "---\nname: reviewer\ndescription: Reviews code\nmodel: sonnet\n---\nYou are the fixture reviewer.\n";

/** A Claude plugin named `fixture` with the given files (relative path to text) and manifest keys. */
function plugin(files: Record<string, string>, manifest: Record<string, unknown> = {}, parent = tmp()): string {
	const root = path.join(parent, "fixture");
	fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture", ...manifest }));
	for (const [file, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	}
	return fs.realpathSync(root);
}

const entries = (root: string) => [{ path: root, protocol: "claude" as const }];
const names = (root: string) =>
	loadConfiguredPluginAgents(entries(root))
		.agents.map((agent) => agent.name)
		.sort();

describe("plugin agent names", () => {
	const file = (relative: string, folders: string[] = []) => ({ file: `/p/agents/${relative}`, folders });

	it("joins the plugin, subfolders and the file name with colons", () => {
		expect(pluginAgentName("my-plugin", file("security.md"))).toBe("my-plugin:security");
		expect(pluginAgentName("my-plugin", file("review/security.md", ["review"]))).toBe("my-plugin:review:security");
	});

	it("lets the frontmatter name replace only the file name", () => {
		expect(pluginAgentName("my-plugin", file("review/security.md", ["review"]), "audit")).toBe(
			"my-plugin:review:audit",
		);
	});

	it("falls back to the file name for a name that cannot be a name part", () => {
		for (const bad of ["has space", "a:b", "", "x".repeat(257), 7, undefined])
			expect(pluginAgentName("p", file("fallback.md"), bad)).toBe("p:fallback");
	});

	it("refuses a file or folder name that cannot be a name part", () => {
		expect(() => pluginAgentName("p", file("two words.md"))).toThrow(/without spaces/);
		expect(() => pluginAgentName("p", file("a.md", ["bad folder"]))).toThrow(/without spaces/);
	});

	it("scans agents/ recursively, and a manifest agents key replaces the scan without subfolders", () => {
		const scanned = plugin({
			"agents/top.md": REVIEWER,
			"agents/review/security.md": REVIEWER,
			"agents/review/notes.txt": "x",
		});
		expect(names(scanned)).toEqual(["fixture:review:reviewer", "fixture:reviewer"]);
		const listed = plugin(
			{ "agents/ignored.md": REVIEWER, "custom/review/security.md": "---\ndescription: s\n---\nBody\n" },
			{ agents: "./custom/review/security.md" },
		);
		expect(names(listed)).toEqual(["fixture:security"]);
	});

	it("rejects a directory in the manifest agents key", () => {
		const root = plugin({ "agents/a.md": REVIEWER }, { agents: "./agents" });
		const manifest = discoverPluginManifests(root, { protocol: "claude" }).manifests[0];
		const components = discoverPluginComponents(manifest);
		expect(components.agents).toEqual([]);
		expect(components.errors.join("\n")).toMatch(/agents: .*directories are not accepted/);
		expect(components.unsupported).not.toContain("agents");
	});

	it("keeps the first of two agents with the same name and reports the second", () => {
		const root = plugin({ "agents/a.md": REVIEWER, "agents/b.md": REVIEWER });
		const loaded = loadConfiguredPluginAgents(entries(root));
		expect(loaded.agents.map((agent) => agent.name)).toEqual(["fixture:reviewer"]);
		expect(loaded.diagnostics.map((item) => item.message).join("\n")).toContain("the second is skipped");
	});
});

describe("Claude agent frontmatter", () => {
	it("carries over the fields that mean the same thing", () => {
		const { frontmatter, unsupported } = translateAgentFields({
			name: "x",
			description: "d",
			model: "haiku",
			maxTurns: 7,
			skills: ["a", "b"],
			tools: "Read, Grep, Bash",
		});
		expect(frontmatter).toMatchObject({
			description: "d",
			model: "haiku",
			maxRequests: 7,
			skills: ["a", "b"],
			tools: "bash",
		});
		expect(unsupported).toEqual([]);
	});

	it("treats model inherit as the default", () => {
		expect(translateAgentFields({ model: "inherit" }).frontmatter).not.toHaveProperty("model");
	});

	it("never grants more than the Claude list allowed: no file-writing tool means read-only", () => {
		expect(translateAgentFields({ tools: ["Read", "Grep"] }).frontmatter).toMatchObject({
			tools: "mcp__*",
			readOnly: true,
		});
		expect(translateAgentFields({ tools: "Read, Edit, Bash" }).frontmatter).toEqual({ tools: "bash" });
		expect(translateAgentFields({ disallowedTools: "Write, Bash(git push *)" }).frontmatter).toEqual({
			excludeTools: "bash",
			readOnly: true,
		});
	});

	it("reports what has no equivalent instead of ignoring it silently", () => {
		const { frontmatter, unsupported } = translateAgentFields({
			hooks: { PreToolUse: [] },
			mcpServers: ["x"],
			permissionMode: "bypassPermissions",
			color: "red",
			lean: true,
			headless: false,
			tools: "Read, Monitor, Bash(git *)",
			maxTurns: 0,
		});
		expect(unsupported).toEqual(
			expect.arrayContaining([
				"hooks",
				"mcpServers",
				"permissionMode",
				"color",
				"lean",
				"headless",
				"tools: Monitor",
				"tools: Bash(git *)",
				"maxTurns: expected a positive integer",
			]),
		);
		expect(frontmatter).not.toHaveProperty("hooks");
		expect(frontmatter).not.toHaveProperty("permissionMode");
		expect(frontmatter).not.toHaveProperty("lean");
	});

	it("keeps permissions, which still asks the user at spawn", () => {
		expect(translateAgentFields({ permissions: ["browser.control"] }).frontmatter).toEqual({
			permissions: ["browser.control"],
		});
	});
});

describe("plugin agents as subagent profiles", () => {
	const setup = () => {
		const home = tmp();
		const cwd = tmp();
		return { home, cwd, env: { OCTOCODE_HOME: path.join(home, "octocode") } as NodeJS.ProcessEnv };
	};

	it("loads agents/reviewer.md as fixture:reviewer with the profile's prompt and mapped fields", () => {
		const { home, cwd, env } = setup();
		const root = plugin({ "agents/reviewer.md": REVIEWER });
		const notes: string[] = [];
		const profile = loadProfiles(cwd, home, true, env, undefined, undefined, {
			plugins: entries(root),
			onNote: (note) => notes.push(note),
		}).get("fixture:reviewer");
		expect(profile).toMatchObject({
			name: "fixture:reviewer",
			description: "Reviews code",
			prompt: "You are the fixture reviewer.",
			model: "sonnet",
		});
		expect(profile?.hash).toBeTruthy();
		expect(notes).toEqual([]);
	});

	it("lists plugin agents in the Agents row with source `plugin <name>`", () => {
		installOctocodeDiscovery();
		const root = plugin({ "agents/reviewer.md": REVIEWER });
		const input = discoveryInput({
			cwd: tmp(),
			agentDir: tmp(),
			home: tmp(),
			projectTrusted: true,
			env: { OCTOCODE_HOME: tmp() },
			piRoots: [],
			plugins: entries(root),
		});
		const item = configDiscovery.discover("agent", input).find((entry) => entry.name === "fixture:reviewer");
		// The startup screen's source label for origin `plugin:<name>` is `plugin <name>`.
		expect(item).toMatchObject({ loaded: true, provenance: { origin: "plugin:fixture", scope: "global" } });
	});

	it("does not load a disabled plugin", () => {
		const { home, cwd, env } = setup();
		const root = plugin({ "agents/reviewer.md": REVIEWER });
		const profiles = loadProfiles(cwd, home, true, env, undefined, undefined, {
			plugins: [{ path: root, protocol: "claude", enabled: false }],
		});
		expect(profiles.has("fixture:reviewer")).toBe(false);
	});

	it("does not replace a user profile with the same name, and says so", () => {
		const { home, cwd, env } = setup();
		fs.mkdirSync(path.join(env.OCTOCODE_HOME!, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(env.OCTOCODE_HOME!, "agents", "mine.md"),
			"---\nname: fixture:reviewer\ndescription: user's own\n---\nUSER_PROMPT\n",
		);
		const root = plugin({ "agents/reviewer.md": REVIEWER });
		const notes: string[] = [];
		const profiles = loadProfiles(cwd, home, true, env, undefined, undefined, {
			plugins: entries(root),
			onNote: (note) => notes.push(note),
		});
		expect(profiles.get("fixture:reviewer")?.prompt).toBe("USER_PROMPT");
		expect(notes.join("\n")).toContain("the plugin agent");
	});

	it("does not replace a project profile with the same name", () => {
		const { home, cwd, env } = setup();
		fs.mkdirSync(path.join(cwd, ".octocode", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".octocode", "agents", "p.md"),
			"---\nname: fixture:reviewer\n---\nPROJECT_PROMPT\n",
		);
		const profiles = loadProfiles(cwd, home, true, env, undefined, undefined, {
			plugins: entries(plugin({ "agents/reviewer.md": REVIEWER })),
		});
		expect(profiles.get("fixture:reviewer")?.prompt).toBe("PROJECT_PROMPT");
	});

	it("reports hooks and other unsupported frontmatter as a note and ignores them", () => {
		const { home, cwd, env } = setup();
		const root = plugin({
			"agents/hooked.md": "---\ndescription: h\nhooks:\n  PreToolUse: []\ncolor: red\n---\nBody\n",
		});
		const notes: string[] = [];
		const profile = loadProfiles(cwd, home, true, env, undefined, undefined, {
			plugins: entries(root),
			onNote: (note) => notes.push(note),
		}).get("fixture:hooked");
		expect(profile).toBeDefined();
		expect(profile?.hooks).toBeUndefined();
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatch(/fixture:hooked: unsupported frontmatter ignored .*: hooks, color/);
	});

	it("keeps permissions: so the spawn still asks", () => {
		const { home, cwd, env } = setup();
		const root = plugin({ "agents/doer.md": "---\ndescription: d\npermissions: [browser.control]\n---\nBody\n" });
		const profile = loadProfiles(cwd, home, true, env, undefined, undefined, { plugins: entries(root) }).get(
			"fixture:doer",
		);
		expect(profile?.permissions).toEqual(["browser.control"]);
	});

	it("skips an agent whose frontmatter does not parse and names the failure", () => {
		const { home, cwd, env } = setup();
		const root = plugin({ "agents/broken.md": "---\nname: [unclosed\n---\nBody\n" });
		const skipped: Array<[string, string | undefined]> = [];
		const profiles = loadProfiles(
			cwd,
			home,
			true,
			env,
			(file, _error, name) => skipped.push([path.basename(file), name]),
			undefined,
			{ plugins: entries(root) },
		);
		expect(profiles.has("fixture:broken")).toBe(false);
		expect(skipped).toEqual([["broken.md", "fixture:broken"]]);
	});

	it("does not load agents of a plugin that lives in an untrusted project folder", () => {
		const { home, cwd, env } = setup();
		const root = plugin({ "agents/reviewer.md": REVIEWER }, {}, path.join(cwd, "vendor"));
		const options = { plugins: entries(root) };
		expect(loadProfiles(cwd, home, false, env, undefined, undefined, options).has("fixture:reviewer")).toBe(false);
		expect(loadProfiles(cwd, home, true, env, undefined, undefined, options).has("fixture:reviewer")).toBe(true);
	});
});
