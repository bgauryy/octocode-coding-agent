import { isMcpToolName } from "../../../../mcp/src/servers.ts";
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
import { shortHash } from "../../utils/atomic-file.ts";
import { globalPaths, nativeAgentDir, projectAgentDirs } from "../shared/home.ts";
import { LOCAL_RESEARCH_TOOLS } from "../../../../mcp/src/presets/octocode/names.ts";

export interface AgentProfile {
	name: string;
	description: string;
	prompt: string;
	tools?: string;
	/** Comma-separated optional tools the child must not have (Octocode's --exclude-tools). */
	excludeTools?: string;
	/** Preferred model: `provider/id`, a bare id, or a purpose (`small`, `medium`), optionally `:thinking`. Unavailable here: the child runs on the parent's model. */
	model?: string;
	/** Browser mode: true (default) is headless; false uses visible Chrome and its persistent login profile. */
	headless?: boolean;
	/** Soft limit on the child's model requests per task, including resumes (`budget.ts`): a steer to wrap up there, a stop at 1.5 times it. 0 turns the budget off for this profile; absent: `OCTOCODE_SUBAGENT_MAX_REQUESTS`, then `DEFAULT_MAX_REQUESTS` (160). */
	maxRequests?: number;
	/** Seconds a finished background run of this profile stays reachable for a follow-up message (`linger.ts`); replaces `OCTOCODE_SUBAGENT_LINGER_SECONDS` for it, and 0 turns it off. A `blocked` report still gets at least `BLOCKED_LINGER_SECONDS`. */
	linger?: number;
	/** Legacy opt-out, rejected because specialists require local research. */
	mcp?: false;
	/** True: the child runs the user's command hooks (`OCTOCODE_SUBAGENT_HOOKS`); by default subagents do not. */
	hooks?: true;
	/**
	 * True: the child investigates and reports without changing source (`OCTOCODE_READ_ONLY`). Its prompt says so, and the
	 * permission gate enforces it in every mode (`permission/read-only-role.ts`): `file` writes are refused outside its
	 * scratch folder, `.octocode/tmp/` and Markdown docs under `.octocode/`, and so are bash commands whose parse changes
	 * the workspace. It is a policy, not a sandbox: a program that writes by itself (`node script.js`) is not seen.
	 */
	readOnly?: true;
	/** Classes the profile asks the user to allow its child (`permissions:` front matter, only the declarable ones); the spawn prompt lists them. */
	permissions?: ActionClass[];
	/** Names in `permissions:` that cannot be declared; ignored, and reported when the profiles load. */
	ignoredPermissions?: string[];
	/** Hash of the profile file's content (set when it is read from a file): any change to it (prompt, model, tools, permissions, flags) is a new question for the user. */
	hash?: string;
	/**
	 * True: a lean child for small models. It runs exactly `tools` (default `LEAN_DEFAULT_TOOLS`) without the specialist
	 * floor, MCP or extensions, and a short subagent prompt replaces the native policy (`instructions/lean.ts`).
	 */
	lean?: true;
	/** Skills the child gets when the task names none (`skills:` front matter); they ride in its task (`task-skills.ts`). */
	skills?: string[];
}

/** A lean profile's tools when its front matter names none. */
export const LEAN_DEFAULT_TOOLS = "bash,file";

/** The role of a subagent started without a profile. */
export const GENERAL_PROFILE = "general";

/** Every child can save files, communicate and recover history; local research is added separately. */
export const CORE_TOOLS = ["file", "agent", "archive"] as const;
/**
 * Tools every child gets by default, unlike `CORE_TOOLS` a profile may remove them (`excludeTools` or a `-` entry):
 * `skill` loads a listed skill by name, and stays out of requests while the child has none.
 */
export const DEFAULT_CHILD_TOOLS = ["skill"] as const;
/** `mcp` restarts the child's own MCP servers. */
export const MCP_ACCESS_TOOLS = ["mcp"] as const;

const BUNDLED_DIR = getSubagentsDir();

/**
 * Profiles by name: bundled, user configuration, runtime home, then trusted project.
 * A shared configuration/runtime directory is read once. A project file that replaces a profile loaded from an
 * earlier source (a bundled role included) is reported through `onShadow`: the project's prompt, tools and flags win.
 */
export function loadProfiles(
	cwd: string,
	home = os.homedir(),
	projectTrusted = true,
	env: NodeJS.ProcessEnv = process.env,
	onSkip: (file: string, error: unknown) => void = () => undefined,
	onShadow: (name: string, file: string, replaced: string) => void = () => undefined,
): Map<string, AgentProfile> {
	const profiles = new Map<string, AgentProfile>();
	const loadedFrom = new Map<string, string>();
	const projectDirs = new Set(projectTrusted ? projectAgentDirs(cwd) : []);
	const dirs = [BUNDLED_DIR, path.join(nativeAgentDir(home), "agents"), globalPaths(env, home).agents, ...projectDirs];
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
				const replaced = loadedFrom.get(profile.name);
				if (replaced && projectDirs.has(dir)) onShadow(profile.name, path.join(dir, file), replaced);
				profiles.set(profile.name, profile);
				loadedFrom.set(profile.name, dir === BUNDLED_DIR ? "bundled" : path.join(dir, file));
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
	const { frontmatter, body } = parseFrontmatter(text);
	const field = (key: string) => (typeof frontmatter[key] === "string" ? frontmatter[key].trim() : undefined);
	for (const key of ["tools", "excludeTools"]) {
		if (frontmatter[key] !== undefined && frontmatter[key] !== null && typeof frontmatter[key] !== "string")
			throw new Error(`${key} must be a comma-separated string`);
	}
	const tools = field("tools");
	const excludeTools = field("excludeTools");
	const model = field("model");
	const { declared, ignored } = declaredPermissions(frontmatter.permissions);
	const name = field("name") ?? fallbackName;
	// Switches take YAML booleans only: a quoted "false" is a string, and a string never flips a switch.
	const flag = (key: string) => {
		const value = frontmatter[key];
		if (value === undefined || typeof value === "boolean") return value;
		throw new Error(`${key} must be true or false, not ${JSON.stringify(value)}`);
	};
	const lean = flag("lean") === true;
	const skills = skillNames(frontmatter.skills);
	// A bad `tools` selector fails the profile when it is loaded, not when it first runs.
	const selected = selectedTools(tools);
	if (lean) leanTools(name, tools);
	else refuseCoreRemoval(name, selected, excludeTools);
	const requests = frontmatter.maxRequests;
	if (requests !== undefined && (typeof requests !== "number" || !Number.isInteger(requests) || requests < 0))
		throw new Error(`maxRequests must be a non-negative integer, not ${JSON.stringify(requests)}`);
	const linger = frontmatter.linger;
	if (linger !== undefined && (typeof linger !== "number" || !Number.isInteger(linger) || linger < 0))
		throw new Error(`linger must be a non-negative integer of seconds, not ${JSON.stringify(linger)}`);
	if (flag("mcp") === false && !lean) throw new Error(mcpRequired(name));
	const visibleBrowser = flag("visibleBrowser");
	const headless = flag("headless") ?? (visibleBrowser === undefined ? undefined : !visibleBrowser);
	return {
		name,
		description: field("description") ?? "",
		prompt: body.trim(),
		...(lean ? { lean: true as const, tools: tools ?? LEAN_DEFAULT_TOOLS } : {}),
		...(tools && !lean ? { tools: withCoreTools(tools, selected) } : {}),
		...(skills ? { skills } : {}),
		...(excludeTools ? { excludeTools } : {}),
		...(model ? { model } : {}),
		...(headless === undefined ? {} : { headless }),
		...(requests === undefined ? {} : { maxRequests: requests }),
		...(linger === undefined ? {} : { linger }),
		...(flag("hooks") === true ? { hooks: true as const } : {}),
		...(flag("readOnly") === true ? { readOnly: true as const } : {}),
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

/** `skills:` front matter: a comma-separated string or a YAML list of skill names. */
function skillNames(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return toolList(value);
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
		return value.map((entry) => entry.trim()).filter(Boolean);
	throw new Error("skills must be a comma-separated string or a list of skill names");
}

/** A lean profile's tool list: explicit names only, since a relative selector would inherit the full default set. */
function leanTools(profile: string, tools: string | undefined): string {
	const list = tools ?? LEAN_DEFAULT_TOOLS;
	if (isRelative(selectedTools(list)))
		throw new Error(
			`Profile "${profile}" is lean: give it an explicit tool list such as ${LEAN_DEFAULT_TOOLS}, without + or - entries.`,
		);
	return list;
}

const mcpRequired = (name: string): string =>
	`Profile "${name}" disables MCP, but every specialist needs Octocode local research. Remove mcp: false.`;

/**
 * An absolute allowlist replaces the selection, so add missing shared capabilities. Relative lists are completed
 * by profileTools at launch, after the parent defaults have been resolved.
 */
function withCoreTools(tools: string, selected: readonly string[] | undefined): string {
	if (isRelative(selected)) return tools;
	// An allowlist without MCP entries implicitly keeps all MCP servers. Preserve that reach when adding local tools.
	const required = [
		...CORE_TOOLS,
		...DEFAULT_CHILD_TOOLS,
		...MCP_ACCESS_TOOLS,
		...(selected?.some(isMcpToolName) ? LOCAL_RESEARCH_TOOLS : ["mcp__*"]),
	];
	return [...toolList(tools), ...required.filter((name) => !matchesTool(selected ?? [], name))].join(",");
}

/** Reject selectors that remove the shared specialist capabilities. */
function refuseCoreRemoval(
	profile: string,
	selected: readonly string[] | undefined,
	excludeTools: string | undefined,
): void {
	const excluded = toolList(excludeTools);
	const removed = (selected ?? []).filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
	const named = [...CORE_TOOLS, ...MCP_ACCESS_TOOLS, ...LOCAL_RESEARCH_TOOLS].filter(
		(name) => matchesTool(excluded, name) || removed.includes(name),
	);
	if (named.length === 0) return;
	throw new Error(
		`Profile "${profile}" removes ${named.join(", ")} with excludeTools or a "-" entry in tools, but every specialist keeps file, communication, history and Octocode local research. Remove ${named.length > 1 ? "them" : "it"} from the profile's excludeTools (a pattern such as "*" counts) or tools.`,
	);
}

/** Resolve the same child selection for launch and permission reach, including programmatic profiles. */
export function profileTools(profile?: AgentProfile): string {
	if (profile?.lean) return leanTools(profile.name, profile.tools);
	const selected = selectedTools(profile?.tools);
	refuseCoreRemoval(profile?.name ?? GENERAL_PROFILE, selected, profile?.excludeTools);
	if (profile?.mcp === false) throw new Error(mcpRequired(profile.name));
	return !selected || isRelative(selected)
		? [
				...(selected ?? []),
				...[...CORE_TOOLS, ...DEFAULT_CHILD_TOOLS, ...MCP_ACCESS_TOOLS, ...LOCAL_RESEARCH_TOOLS].map(
					(name) => `+${name}`,
				),
			].join(",")
		: withCoreTools(profile!.tools!, selected);
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
	const selected = selectedTools(profileTools(profile));
	return (
		!matchesTool(profileExcludes(profile?.excludeTools), name) &&
		(selected && !isRelative(selected)
			? matchesTool(selected, name)
			: applyToolModifiers(defaults, selected ?? []).includes(name))
	);
}

/** The workspace classes exposed by the child's native selection and Octocode's direct extension tools. */
export function profileReach(profile: AgentProfile | undefined, defaultTools?: readonly string[]): ActionClass[] {
	const nativeDefaults = ["bash", "file"];
	const configured =
		SettingsManager.inMemory(defaultTools ? { defaultTools: [...defaultTools] } : {}).getDefaultTools(nativeDefaults) ??
		nativeDefaults;
	return [
		...(profileSelectsTool(profile, "file", configured) ? ["file.workspace" as const] : []),
		...(profileSelectsTool(profile, "bash", configured) || profileSelectsTool(profile, "debug", configured)
			? ["shell" as const]
			: []),
	];
}

const REACH_TEXT: Record<string, string> = {
	"file.workspace": "edit files in the repository",
	shell: "run shell commands or debugger operations",
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
		reach.length > 0 ? `may ${reach.map((action) => REACH_TEXT[action]).join(" and ")}` : "may only read and research";
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
	if (needsAnswer && (verdict.via === "user" || verdict.via === "hook")) permission.markProfileSeen(seen);
	return [...new Set([...(verdict.via === "mode" ? [] : reach), ...declared])];
}
