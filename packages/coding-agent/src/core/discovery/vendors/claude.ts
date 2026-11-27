import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoKey } from "../../../utils/git-repository.ts";
import { claudeConfigDir } from "../../../utils/host-config.ts";
import { dirsToRepoRoot } from "../../../utils/repo-dirs.ts";
import { makeItem } from "../roots.ts";
import { externalSkillsEnabled, hookFileItems, listsProject, skillItemsIn, withinTrust } from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

const ROOT = { product: "octocode", vendor: "claude", origin: "claude" } as const;

const claudeDir = (input: DiscoverInput) => claudeConfigDir(input.home, input.env ?? process.env);

/** The project's Claude settings files; none when the repository root lies outside the trust grant's folder. */
const projectClaudeFiles = (input: DiscoverInput) => {
	const root = repoKey(input.cwd).root;
	return withinTrust(input, root)
		? ["settings.json", "settings.local.json"].map((name) => path.join(root, ".claude", name))
		: [];
};

/** `~/.claude/skills` and the workspace's `.claude/skills` (cwd up to its repository root), without `synced/`. */
function skills(input: DiscoverInput): ConfigItem[] {
	if (!externalSkillsEnabled(input.env ?? process.env)) return [];
	const project = listsProject(input)
		? dirsToRepoRoot(input.cwd)
				.filter((dir) => withinTrust(input, dir))
				.map((dir) => path.join(dir, ".claude", "skills"))
		: [];
	return [
		...skillItemsIn(project, { ...ROOT, scope: "project" }, input, { skipSynced: true }),
		...skillItemsIn([path.join(claudeDir(input), "skills")], { ...ROOT, scope: "global" }, input, { skipSynced: true }),
	];
}

/** `~/.claude/settings.json`, then the workspace's `.claude/settings.json` and `settings.local.json`. */
function hooks(input: DiscoverInput): ConfigItem[] {
	return [
		...hookFileItems([path.join(claudeDir(input), "settings.json")], "claude", "global", input),
		...(listsProject(input) ? hookFileItems(projectClaudeFiles(input), "claude", "project", input) : []),
	];
}

/** Claude Code's folder name for a project: its path with every character outside `[A-Za-z0-9]` as `-`. */
const claudeProjectDirName = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, "-");

/**
 * The auto memory folder of this workspace: `autoMemoryDirectory` from Claude's settings (user, then the project's
 * files, the last one set wins), else `<claude dir>/projects/<repository root, encoded>/memory`, where
 * `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the encoded name. Only this workspace's folder is ever read.
 */
export function claudeMemoryDir(input: DiscoverInput): { dir: string; diagnostics: string[] } {
	const env = input.env ?? process.env;
	const diagnostics: string[] = [];
	let configured: string | undefined;
	for (const file of [path.join(claudeDir(input), "settings.json"), ...projectClaudeFiles(input)]) {
		if (!existsSync(file)) continue;
		try {
			const value = (JSON.parse(readFileSync(file, "utf8")) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
			if (typeof value === "string" && value) configured = value;
		} catch (error) {
			diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (configured) {
		const expanded = configured.startsWith("~/") ? path.join(input.home, configured.slice(2)) : configured;
		return { dir: path.resolve(input.cwd, expanded), diagnostics };
	}
	const root = dirsToRepoRoot(input.cwd).at(-1) ?? path.resolve(input.cwd);
	let real = root;
	try {
		real = realpathSync(root);
	} catch {
		/* A missing folder keeps its spelling. */
	}
	const name = env.CLAUDE_CODE_PROJECT_DIR_NAME || claudeProjectDirName(real);
	return { dir: path.join(claudeDir(input), "projects", name, "memory"), diagnostics };
}

/** This workspace's `MEMORY.md`, for a trusted folder; its own switch (`harness:claude:memory`) decides whether it loads. */
function memory(input: DiscoverInput): ConfigItem[] {
	if (!input.projectTrusted) return [];
	const { dir, diagnostics } = claudeMemoryDir(input);
	const file = path.join(dir, "MEMORY.md");
	if (!existsSync(file)) return [];
	const item = makeItem("memory", "MEMORY.md", { ...ROOT, scope: "global" }, file, input, { baseDir: dir });
	return [{ ...item, diagnostics }];
}

/** Claude Code: skills, hooks, MCP servers and (its own switch) auto memory. Off until the user enables it in `/harness`. */
export const claudeVendor: Vendor = {
	id: "claude",
	label: "Claude Code",
	defaultOn: vendorDefaultOn("claude"),
	switchable: true,
	sources: [
		{ kind: "skill", discover: skills },
		{ kind: "hook", discover: hooks },
		{ kind: "memory", discover: memory },
		mcpSource("claude"),
	],
};
