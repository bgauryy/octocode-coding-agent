import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDiscovery, discoveryInput } from "../../core/discovery/service.ts";
import { type PluginProfileOptions, translateAgentFields } from "../../core/plugin-agent-fields.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { selectsToolPrefix } from "../../core/agent-session/tool-selection.ts";
import { applyToolModifiers, SettingsManager } from "../../core/settings-manager.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { Permission } from "../permission/ask.ts";
import type { PermissionRequest } from "../permission/request.ts";
import { type ActionClass, actionNoun, actionWhy, decide, declaredPermissions } from "../permission/mode.ts";
import { shortHash } from "@octocodeai/octocode-common/atomic-file";
import { installOctocodeDiscovery } from "../discovery/index.ts";
import { globalPaths } from "../shared/home.ts";
import { HOOK_MODES, type HookMode } from "../shared/hook-mode.ts";
import { CORE_TOOLS, DEFAULT_CHILD_TOOLS, localResearchTools, MCP_ACCESS_TOOLS, SHELL_TOOLS } from "./core-tools.ts";
import {
	isRelative,
	leanTools,
	matchesTool,
	mcpRequired,
	refuseCoreRemoval,
	selectedTools,
	toolList,
	withCoreTools,
} from "./profile-tools.ts";
import { MCP_DEFER_ROLES, type McpDeferRole } from "../../../../mcp/src/api.ts";
import { BROWSER_SERVER, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";

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
	/** MCP tool roles (`readOnly`) whose tools the child defers instead of declaring: still callable, loaded through the `mcp` tool (`mcpDefer` front matter; the roles come from each server's `roles`). */
	mcpDefer?: McpDeferRole[];
	/** Legacy opt-out, rejected because specialists require local research. */
	mcp?: false;
	/**
	 * How much of the user's hooks the child runs (`hooks:` front matter: `false`/`off`, `decisions`, `true`/`all`). Absent:
	 * the task's `hooks` field decides, else none run. `off` forbids them whatever the task asks (`childHookMode`).
	 */
	hooks?: HookMode;
	/**
	 * True: the child investigates and reports without changing source (`OCTOCODE_READ_ONLY`). Its prompt says so, and the
	 * permission gate enforces it in every mode (`permission/read-only-role.ts`): `file` writes are refused outside its
	 * scratch folder, `.octocode/code/temp/` and Markdown docs under `.octocode/`, and so are bash commands whose parse changes
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
	 * floor, MCP or features, and a short subagent prompt replaces the native policy (`native/prompts/lean.ts`).
	 */
	lean?: true;
	/** Skills the child gets when the task names none (`skills:` front matter): inlined in its role prompt, or its task when lean (`task-skills.ts`). */
	skills?: string[];
	/** Skills the child's prompt lists (`catalog:` front matter); the rest stay loadable by name and the prompt counts them. Absent: all are listed; empty (`catalog: []`): none. */
	catalog?: string[];
}

/** The role of a subagent started without a profile. */
export const GENERAL_PROFILE = "general";

export { CORE_TOOLS, DEFAULT_CHILD_TOOLS, MCP_ACCESS_TOOLS, SHELL_TOOLS };

/**
 * Profiles by name: bundled, the Octocode home (`OCTOCODE_HOME`, else `<home>/.octocode/octocodecode`), then trusted project. A project file that replaces a profile loaded from an
 * earlier source (a bundled role included) is reported through `onShadow`: the project's prompt, tools and flags win.
 * `options.plugins` add `<plugin>:<agent>` profiles; they load first, so any other profile of that name replaces one (`onNote`).
 */
export function loadProfiles(
	cwd: string,
	home = os.homedir(),
	projectTrusted = true,
	env: NodeJS.ProcessEnv = process.env,
	onSkip: (file: string, error: unknown, name?: string) => void = () => undefined,
	onShadow: (name: string, file: string, replaced: string) => void = () => undefined,
	options: PluginProfileOptions = {},
): Map<string, AgentProfile> {
	const profiles = new Map<string, AgentProfile>();
	const loadedFrom = new Map<string, string>();
	const pluginFiles = new Map<string, string>();
	installOctocodeDiscovery();
	const input = discoveryInput({
		cwd,
		agentDir: globalPaths(env, home).home,
		home,
		projectTrusted,
		env,
		piRoots: [],
		...(options.plugins ? { plugins: options.plugins } : {}),
	});
	// Discovery lists the highest precedence first; reading it backwards loads bundled, then global, then project, so a later
	// profile replaces an earlier one of the same name and each replacement is reported here.
	const files = configDiscovery
		.discover("agent", input)
		.filter((item) => !item.provenance.notLoaded)
		.reverse();
	for (const { name: scoped, provenance } of files) {
		const file = provenance.path;
		const plugin = provenance.origin.startsWith("plugin:");
		// Bad YAML or an unreadable entry skips that profile only; the rest still load.
		try {
			const text = fs.readFileSync(file, "utf8");
			const note = (keys: string[]) =>
				options.onNote?.(`${scoped}: unsupported frontmatter ignored in ${file}: ${keys.join(", ")}`);
			const profile = parseProfile(plugin ? scoped : profileFileName(file), text, plugin ? note : undefined);
			const replaced = loadedFrom.get(profile.name);
			if (replaced && !plugin && replaced === pluginFiles.get(profile.name))
				options.onNote?.(`${profile.name}: the plugin agent ${replaced} is not used; ${file} has the same name`);
			else if (replaced && provenance.scope === "project") onShadow(profile.name, file, replaced);
			profiles.set(profile.name, profile);
			loadedFrom.set(profile.name, provenance.scope === "builtin" ? "bundled" : file);
			if (plugin) pluginFiles.set(profile.name, file);
		} catch (error) {
			onSkip(file, error, plugin ? scoped : undefined);
		}
	}
	return profiles;
}

/** The name a profile file answers to when its front matter names none: the file name without `.md`. */
export const profileFileName = (file: string): string => path.basename(file, ".md");

/** A profile from its file. With `onUnsupported` it is a Claude plugin agent named `fallbackName`: its frontmatter is translated (`core/plugin-agent-fields.ts`) and what has no equivalent is reported and ignored. */
export function parseProfile(
	fallbackName: string,
	text: string,
	onUnsupported?: (unsupported: string[]) => void,
): AgentProfile {
	const parsed = parseFrontmatter(text);
	const translated = onUnsupported ? translateAgentFields(parsed.frontmatter) : undefined;
	if (translated && translated.unsupported.length > 0) onUnsupported!(translated.unsupported);
	const frontmatter = translated ? { ...translated.frontmatter, name: fallbackName } : parsed.frontmatter;
	const { body } = parsed;
	const field = (key: string) => (typeof frontmatter[key] === "string" ? frontmatter[key].trim() : undefined);
	for (const key of ["tools", "excludeTools"]) {
		if (frontmatter[key] !== undefined && frontmatter[key] !== null && typeof frontmatter[key] !== "string")
			throw new Error(`${key} must be a comma-separated string`);
	}
	const tools = field("tools");
	const excludeTools = field("excludeTools");
	const model = field("model");
	const mcpDefer = deferRoleNames(frontmatter.mcpDefer);
	const { declared, ignored } = declaredPermissions(frontmatter.permissions);
	const name = field("name") ?? fallbackName;
	// Switches take YAML booleans only: a quoted "false" is a string, and a string never flips a switch.
	const flag = (key: string) => {
		const value = frontmatter[key];
		if (value === undefined || typeof value === "boolean") return value;
		throw new Error(`${key} must be true or false, not ${JSON.stringify(value)}`);
	};
	const lean = flag("lean") === true;
	const hooks = hookModeOf(frontmatter.hooks);
	const skills = skillNames(frontmatter.skills);
	const catalog = skillNames(frontmatter.catalog);
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
		...(lean ? { lean: true as const, tools: leanTools(name, tools) } : {}),
		...(tools && !lean ? { tools: withCoreTools(tools, selected) } : {}),
		...(skills ? { skills } : {}),
		...(catalog ? { catalog } : {}),
		...(excludeTools ? { excludeTools } : {}),
		...(mcpDefer ? { mcpDefer } : {}),
		...(model ? { model } : {}),
		...(headless === undefined ? {} : { headless }),
		...(requests === undefined ? {} : { maxRequests: requests }),
		...(linger === undefined ? {} : { linger }),
		...(hooks ? { hooks } : {}),
		...(flag("readOnly") === true ? { readOnly: true as const } : {}),
		...(declared.length > 0 ? { permissions: declared } : {}),
		...(ignored.length > 0 ? { ignoredPermissions: ignored } : {}),
		hash: shortHash(text),
	};
}

/** `hooks:` front matter: `true` is `all` and `false` is `off`; any other value fails the profile. */
function hookModeOf(value: unknown): HookMode | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value ? "all" : "off";
	const mode = HOOK_MODES.find((each) => each === value);
	if (mode) return mode;
	throw new Error(`hooks must be false, off, decisions, true or all, not ${JSON.stringify(value)}`);
}

/** `mcpDefer:` front matter: a role name or a list of them (`none` or empty: nothing deferred); an unknown role fails the profile. */
function deferRoleNames(value: unknown): McpDeferRole[] | undefined {
	if (value === undefined || value === null) return undefined;
	const names = typeof value === "string" ? toolList(value) : value;
	if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
		throw new Error(`mcpDefer must be a role name or a list of them, not ${JSON.stringify(value)}`);
	const roles = names.map((name) => name.trim()).filter((name) => name && name !== "none");
	const unknown = roles.filter((name) => !MCP_DEFER_ROLES.some((role) => role === name));
	if (unknown.length > 0)
		throw new Error(`mcpDefer names unknown role ${unknown.join(", ")} (use ${MCP_DEFER_ROLES.join(", ")} or none)`);
	return roles.length > 0 ? MCP_DEFER_ROLES.filter((role) => roles.includes(role)) : undefined;
}

/** `skills:` and `catalog:` front matter: a comma-separated string or a YAML list of skill names. */
function skillNames(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return toolList(value);
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
		return value.map((entry) => entry.trim()).filter(Boolean);
	throw new Error("skills must be a comma-separated string or a list of skill names");
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
				...[
					// A `-bash` entry keeps the shell out: the profile swaps it for another one.
					...SHELL_TOOLS.filter((name) => !selected?.includes(`-${name}`)),
					...CORE_TOOLS,
					...DEFAULT_CHILD_TOOLS,
					...MCP_ACCESS_TOOLS,
					...localResearchTools(),
				].map((name) => `+${name}`),
			].join(",")
		: withCoreTools(profile!.tools!, selected);
}

export function profileExcludes(excludeTools: string | undefined): string[] {
	return toolList(excludeTools);
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

/** Whether the profile names the MCP server's tools itself: a broad `mcp__*` does not count. */
export function profileSelectsServer(profile: AgentProfile | undefined, server: string): boolean {
	const selected = selectedTools(profileTools(profile));
	const relative = !selected || isRelative(selected);
	return selectsToolPrefix(`${mcpNamespace(server)}__`, false, {
		...(relative ? {} : { allowed: selected }),
		excluded: profileExcludes(profile?.excludeTools),
		modifiers: relative ? (selected ?? []) : [],
	});
}

/** Whether the profile selects the browser MCP server's tools: the capability `headless` applies to. */
export const profileSelectsBrowser = (profile: AgentProfile | undefined): boolean =>
	profileSelectsServer(profile, BROWSER_SERVER);

/** The workspace classes exposed by the child's native selection and Octocode's direct feature tools. */
export function profileReach(profile: AgentProfile | undefined, defaultTools?: readonly string[]): ActionClass[] {
	const nativeDefaults = ["bash", "file"];
	const configured =
		SettingsManager.inMemory(defaultTools ? { defaultTools: [...defaultTools] } : {}).getDefaultTools(nativeDefaults) ??
		nativeDefaults;
	return [
		...(profileSelectsTool(profile, "file", configured) ? ["file.workspace" as const] : []),
		...(profileSelectsTool(profile, "bash", configured) ? ["shell" as const] : []),
	];
}

const REACH_TEXT: Record<string, string> = {
	"file.workspace": "edit files in the repository",
	shell: "run shell commands",
};

/** The `agent.spawn` request for `profile`'s child: what it reaches and declares, and the answer the profile still needs. */
export function spawnRequest(
	permission: Permission,
	ctx: Pick<FeatureContext, "cwd">,
	profile: AgentProfile | undefined,
	task: string,
	defaultTools: readonly string[] | undefined,
	origin: { toolCallId?: string; goal?: string; apps?: readonly string[] },
) {
	const name = profile?.name ?? GENERAL_PROFILE;
	const reach = profileReach(profile, defaultTools);
	const declared = profile?.permissions ?? [];
	// A read-only role keeps `file` for its reports and `permission/read-only-role.ts` refuses repository edits, whatever it is granted.
	const shown = profile?.readOnly ? reach.filter((action) => action !== "file.workspace") : reach;
	const may =
		shown.length > 0 ? `may ${shown.map((action) => REACH_TEXT[action]).join(" and ")}` : "may only read and research";
	// One identity for both remembered answers: the profile's name and the hash of its whole content.
	const seen = `${name} ${profile?.hash ?? ""}`;
	const needsAnswer = declared.length > 0 && !permission.profileSeen(seen);
	// A declared class that asks even in full (`desktop.control`) makes this spawn that ask too, every time: the child cannot ask,
	// so this answer is its consent, and no session grant or remembered profile answers it.
	const alwaysAsk = declared.filter((action) => decide("full", action) === "ask");
	const desktopScope = origin.apps?.length ? `only: ${origin.apps.join(", ")}` : "only the apps its task names";
	const request: PermissionRequest = {
		action: "agent.spawn",
		...(alwaysAsk.length > 0 ? { also: alwaysAsk } : {}),
		title: "Start this subagent?",
		what: [
			`${name} ${declared.includes("desktop.control") ? `will control your real desktop (${desktopScope}), and ` : ""}${may}; other actions follow the child's permission policy.`,
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
	};
	return { request, reach, declared, seen, needsAnswer };
}

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
	ctx: Pick<FeatureContext, "hasUI" | "ui" | "cwd">,
	profile: AgentProfile | undefined,
	task: string,
	signal?: AbortSignal,
	defaultTools?: readonly string[],
	/** `answered` hears how the spawn was allowed (`mode`, `grant`, `user`, `hook`), for `spawnStillAllowed` later. */
	origin: { toolCallId?: string; goal?: string; apps?: readonly string[]; answered?: (via: string) => void } = {},
): Promise<ActionClass[]> {
	const { request, reach, declared, seen, needsAnswer } = spawnRequest(
		permission,
		ctx,
		profile,
		task,
		defaultTools,
		origin,
	);
	const verdict = await permission.check(ctx, { ...request, ...(signal ? { signal } : {}) });
	if (!verdict.allowed) throw new Error(verdict.message);
	origin.answered?.(verdict.via);
	if (needsAnswer && (verdict.via === "user" || verdict.via === "hook")) permission.markProfileSeen(seen);
	return [...new Set([...(verdict.via === "mode" ? [] : reach), ...declared])];
}
