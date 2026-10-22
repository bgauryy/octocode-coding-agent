import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../../cli/args.ts";
import { getSubagentsDir } from "../../config.ts";
import type { ExtensionContext } from "../../core/extensions/index.ts";
import { applyToolModifiers, SettingsManager } from "../../core/settings-manager.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { Permission } from "../permission/ask.ts";
import { type ActionClass, actionNoun, actionWhy, declaredPermissions } from "../permission/mode.ts";
import { shortHash } from "../shared/atomic.ts";
import { globalPaths, nativeAgentDir, projectAgentDirs } from "../shared/home.ts";

export interface AgentProfile {
	name: string;
	description: string;
	prompt: string;
	tools?: string;
	/** Comma-separated tools the child must not have (Octocode's --exclude-tools), e.g. `file` for read-only profiles. */
	excludeTools?: string;
	/** Preferred model: `provider/id`, a bare id, or a purpose (`small`, `medium`), optionally `:thinking`. Unavailable here: the child runs on the parent's model. */
	model?: string;
	/** When set, the child's `browser` tool opens a visible Chrome on the persistent profile (logins stay). */
	visibleBrowser?: boolean;
	/** False: the child starts no MCP servers (their tool schemas would be paid on every request for nothing). */
	mcp?: false;
	/** True: the child runs the user's command hooks (`OCTOCODE_HOOKS`); by default subagents do not. */
	hooks?: true;
	/** Classes the profile asks the user to allow its child (`permissions:` front matter, only the declarable ones); the spawn prompt lists them. */
	permissions?: ActionClass[];
	/** Names in `permissions:` that cannot be declared; ignored, and reported when the profiles load. */
	ignoredPermissions?: string[];
	/** Hash of the profile file's content (set when it is read from a file): any change to it (prompt, model, tools, permissions, flags) is a new question for the user. */
	hash?: string;
}

/** The role of a subagent started without a profile. */
export const GENERAL_PROFILE = "general";

/**
 * Tools every subagent keeps whatever its profile says: `sendMessage` and `coordinate` are how it reaches its parent
 * (a `--tools` allowlist drops extension tools it does not name), `read` is how it reads what it is sent, `archive`
 * how it reads its parent's history (read-only). A profile with an allowlist gets them added when it loads; one that
 * excludes or removes them is refused.
 */
export const CORE_TOOLS = ["read", "sendMessage", "coordinate", "archive"] as const;

const BUNDLED_DIR = getSubagentsDir();

/**
 * Profiles by name: bundled, user configuration, runtime home, then trusted project.
 * A shared configuration/runtime directory is read once.
 */
export function loadProfiles(
	cwd: string,
	home = os.homedir(),
	projectTrusted = true,
	env: NodeJS.ProcessEnv = process.env,
	onSkip: (file: string, error: unknown) => void = () => undefined,
): Map<string, AgentProfile> {
	const profiles = new Map<string, AgentProfile>();
	const dirs = [
		BUNDLED_DIR,
		path.join(nativeAgentDir(home), "agents"),
		globalPaths(env, home).agents,
		...(projectTrusted ? projectAgentDirs(cwd) : []),
	];
	for (const dir of new Set(dirs)) {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
		} catch {
			continue;
		}
		for (const file of files) {
			// Bad YAML or an unreadable entry skips that profile only; the rest still load.
			try {
				const profile = parseProfile(profileFileName(file), fs.readFileSync(path.join(dir, file), "utf8"));
				profiles.set(profile.name, profile);
			} catch (error) {
				onSkip(path.join(dir, file), error);
			}
		}
	}
	return profiles;
}

/** The name a profile file answers to when its front matter names none: the file name without `.md`. */
export const profileFileName = (file: string): string => path.basename(file, ".md");

export function parseProfile(fallbackName: string, text: string): AgentProfile {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const field = (key: string) =>
		typeof frontmatter[key] === "string" ? (frontmatter[key] as string).trim() : undefined;
	for (const key of ["tools", "excludeTools"]) {
		if (frontmatter[key] !== undefined && frontmatter[key] !== null && typeof frontmatter[key] !== "string")
			throw new Error(`${key} must be a comma-separated string`);
	}
	const tools = field("tools");
	const excludeTools = field("excludeTools");
	const model = field("model");
	const { declared, ignored } = declaredPermissions(frontmatter.permissions);
	const name = field("name") ?? fallbackName;
	// A bad `tools` selector fails the profile when it is loaded, not when it first runs.
	const selected = selectedTools(tools);
	refuseCoreRemoval(name, selected, excludeTools);
	// Switches take YAML booleans only: a quoted "false" is a string, and a string never flips a switch.
	const flag = (key: string) => {
		const value = frontmatter[key];
		if (value === undefined || typeof value === "boolean") return value;
		throw new Error(`${key} must be true or false, not ${JSON.stringify(value)}`);
	};
	return {
		name,
		description: field("description") ?? "",
		prompt: body.trim(),
		...(tools ? { tools: withCoreTools(tools, selected) } : {}),
		...(excludeTools ? { excludeTools } : {}),
		...(model ? { model } : {}),
		...(flag("visibleBrowser") === true ? { visibleBrowser: true } : {}),
		...(flag("mcp") === false ? { mcp: false as const } : {}),
		...(flag("hooks") === true ? { hooks: true as const } : {}),
		...(declared.length > 0 ? { permissions: declared } : {}),
		...(ignored.length > 0 ? { ignoredPermissions: ignored } : {}),
		hash: shortHash(text),
	};
}

const toolList = (list: string | undefined): string[] =>
	(list ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

/** Octocode owns selector validation. Its matcher is private; only `*` is special in a tool-name pattern. */
function selectedTools(tools: string | undefined): string[] | undefined {
	if (!tools) return undefined;
	const parsed = parseArgs(["--tools", tools]);
	const error = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error");
	if (error) throw new Error(error.message);
	return parsed.tools;
}

const matchesTool = (patterns: readonly string[], name: string): boolean =>
	patterns.some((pattern) =>
		new RegExp(
			`^${pattern
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
		).test(name),
	);

const isRelative = (selected: readonly string[] | undefined): boolean =>
	selected?.some((name) => /^[+-]/.test(name)) === true;

/**
 * An absolute allowlist replaces Octocode's whole selection, extension tools included, so it gets the core tools it does
 * not already match. A relative list (`+name`/`-name`) changes the default selection, which has them: it is unchanged.
 */
function withCoreTools(tools: string, selected: readonly string[] | undefined): string {
	if (isRelative(selected)) return tools;
	return [...toolList(tools), ...CORE_TOOLS.filter((name) => !matchesTool(selected ?? [], name))].join(",");
}

/** A profile that excludes (any pattern matching) or removes (`-name`) a core tool would cut its child off from its parent: refused when it loads. */
function refuseCoreRemoval(
	profile: string,
	selected: readonly string[] | undefined,
	excludeTools: string | undefined,
): void {
	const excluded = toolList(excludeTools);
	const removed = (selected ?? []).filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
	const named = CORE_TOOLS.filter((name) => matchesTool(excluded, name) || removed.includes(name));
	if (named.length === 0) return;
	throw new Error(
		`Profile "${profile}" removes ${named.join(", ")} with excludeTools or a "-" entry in tools, but every subagent keeps ${CORE_TOOLS.join(", ")} to reach its parent. Remove ${named.length > 1 ? "them" : "it"} from the profile's excludeTools (a pattern such as "*" counts) or tools.`,
	);
}

/** Excluding our file tool also excludes the native tools it replaces, including when a pattern matches it. */
export function profileExcludes(excludeTools: string | undefined): string[] {
	const excluded = toolList(excludeTools);
	return [...new Set(matchesTool(excluded, "file") ? [...excluded, "edit", "write"] : excluded)];
}

export function profileSelectsTool(
	profile: AgentProfile | undefined,
	name: string,
	defaults: readonly string[],
): boolean {
	const selected = selectedTools(profile?.tools);
	return (
		!matchesTool(profileExcludes(profile?.excludeTools), name) &&
		(selected && !isRelative(selected)
			? matchesTool(selected, name)
			: applyToolModifiers(defaults, selected ?? []).includes(name))
	);
}

/** The workspace classes exposed by the child's native selection and Octocode's direct extension tools. */
export function profileReach(profile: AgentProfile | undefined, defaultTools?: readonly string[]): ActionClass[] {
	const nativeDefaults = ["read", "bash", "file"];
	const configured =
		SettingsManager.inMemory(defaultTools ? { defaultTools: [...defaultTools] } : {}).getDefaultTools(
			nativeDefaults,
		) ?? nativeDefaults;
	return [
		...(profileSelectsTool(profile, "file", configured) ? ["file.workspace" as const] : []),
		...(["bash", "powershell"].some((name) => profileSelectsTool(profile, name, configured))
			? ["shell" as const]
			: []),
	];
}

const REACH_TEXT: Record<string, string> = {
	"file.workspace": "edit files in the repository",
	shell: "run shell commands",
};

/**
 * The `agent.spawn` ask, showing the profile, what its tools reach, the permissions it declares and the task. Returns
 * the grant for the child: the classes the profile reaches when the user allowed this spawn (none when the mode itself
 * allows spawning: the child inherits the mode), and the classes the profile declared. A profile that declares
 * permissions forces this prompt in manual and workspace (reason `profile.permissions`), listing each class; the answer
 * is remembered for the session for that profile's content, so an edit asks again. Full allows it and records the
 * reason. A refusal throws, before anything starts.
 */
export async function askSpawn(
	permission: Permission,
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "cwd">,
	profile: AgentProfile | undefined,
	task: string,
	signal?: AbortSignal,
	defaultTools?: readonly string[],
	origin: { toolCallId?: string; goal?: string } = {},
): Promise<ActionClass[]> {
	const name = profile?.name ?? GENERAL_PROFILE;
	const reach = profileReach(profile, defaultTools);
	const declared = profile?.permissions ?? [];
	const may =
		reach.length > 0
			? `may ${reach.map((action) => REACH_TEXT[action]).join(" and ")}`
			: "may only read and research";
	// One identity for both remembered answers: the profile's name and the hash of its whole content.
	const seen = `${name} ${profile?.hash ?? ""}`;
	const needsAnswer = declared.length > 0 && !permission.profileSeen(seen);
	const verdict = await permission.check(ctx, {
		action: "agent.spawn",
		title: "Start this subagent?",
		what: [
			`${name} ${may}; other actions follow the child's permission policy.`,
			...declared.map((action) => `permission it declares: ${action} (${actionNoun(action)})`),
			`task: ${task}`,
		],
		...(needsAnswer
			? {
					reasons: ["profile.permissions" as const],
					reason: declared.map((action) => `the profile declares ${action}: ${actionWhy(action)}`).join("\n"),
				}
			: {}),
		// Keyed by the profile's content, and by reach (which also depends on the parent's default tools): an edited profile is a new question.
		grant: { key: `${seen} ${reach.join(",")}`, label: `${name} subagents` },
		...(origin.toolCallId ? { toolCallId: origin.toolCallId } : {}),
		...(origin.goal ? { purpose: origin.goal } : {}),
		cwd: ctx.cwd,
		...(signal ? { signal } : {}),
	});
	if (!verdict.allowed) throw new Error(verdict.message);
	if (needsAnswer && verdict.via === "user") permission.markProfileSeen(seen);
	return [...new Set([...(verdict.via === "mode" ? [] : reach), ...declared])];
}
