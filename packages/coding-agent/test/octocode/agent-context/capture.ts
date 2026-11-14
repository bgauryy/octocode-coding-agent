import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	contentText,
	createFauxCore,
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type Tool,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { resolveJsonSchemaStrictSampling } from "@octocodeai/octocode-ai/api/constrained-sampling";
import { parseArgs } from "../../../src/cli/args.ts";
import { getOctocodeSkillsDir } from "../../../src/config.ts";
import type { ExtensionFactory } from "../../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createTestSession } from "../../helpers/session.ts";
import { trustFolder } from "../helpers.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	adoptSkillResourceSnapshot,
	captureSkillResourceSnapshot,
	readSkillResourceSnapshot,
	type SkillResourceSnapshot,
} from "../../../src/core/skill-resource-snapshot.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getSkillCommands } from "../../../src/core/skill-commands.ts";
import type { SlashCommandInfo } from "../../../src/core/slash-commands.ts";
import { writeRolePrompt } from "../../../src/octocode/instructions/role.ts";
import { withIdentity } from "../../../src/octocode/instructions/task.ts";
import { shortPath } from "../../../src/utils/display-path.ts";
import { bundledSkillDirs } from "../../../src/octocode/skills.ts";
import { subagentProcessEnv, type Identity } from "../../../src/octocode/subagents/process/env.ts";
import { buildAgentArgs } from "../../../src/octocode/subagents/process/session.ts";
import { GENERAL_PROFILE, loadProfiles, type AgentProfile } from "../../../src/octocode/subagents/profiles.ts";
import { taskSkillPlan, taskSkillText, withRoleSkills } from "../../../src/octocode/subagents/task-skills.ts";
import { childTaskInput } from "../../../src/octocode/subagents/task-text.ts";

export const PACKAGE_DIR = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/** The task text the main session and each child receive; fixed so the output does not depend on a prompt. */
const MAIN_REQUEST = "[The user's first message]";
const CHILD_TASK = "[The parent's task: objective, scope, known facts and acceptance checks]";
const CHILD_GOAL = "[the goal the parent named for this child]";

/** The AGENTS.md every captured agent finds in its working directory, so the `project_context` section is visible. */
const PROJECT_INSTRUCTIONS = "# Example project\n\nRun `yarn test` before reporting. Keep source files short.\n";

export interface CapturedTool {
	name: string;
	description: string;
	parameters: unknown;
	/** What a provider with strict tool mode would send for it: strict, not strict, or the error that refuses it. */
	strict?: boolean | { refused: string };
}

export function strictResolution(tool: Tool): boolean | { refused: string } {
	try {
		return resolveJsonSchemaStrictSampling(tool, true) === true;
	} catch (error) {
		return { refused: (error as Error).message };
	}
}

/** The first model request one agent receives, with machine-specific values replaced by fixed ones. */
export interface AgentContext {
	/** The folder name under `.octocode/tmp/agent-prompts/`. */
	name: string;
	kind: "main" | "child";
	/** The bundled role a child runs; none for the main session and the generic child. */
	role?: string;
	/** Named system prompt sections in order (each wrapped in its tag), then any text outside a section. */
	sections: Array<{ name: string; text: string }>;
	tools: CapturedTool[];
	messages: Array<{ role: string; text: string }>;
}

export interface Fixture {
	root: string;
	cwd: string;
	home: string;
	agentDir: string;
	octocodeHome: string;
	scratch: string;
	replacements: Array<[string, string]>;
}

export function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-context-"));
	const dir = (name: string) => {
		const made = path.join(root, name);
		fs.mkdirSync(made, { recursive: true });
		return made;
	};
	const cwd = dir("project");
	const home = dir("home");
	const agentDir = dir("agent");
	const octocodeHome = dir("octocode-home");
	const scratch = path.join(cwd, ".octocode", "code", "temp", "agents", "child-example");
	fs.mkdirSync(scratch, { recursive: true });
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), PROJECT_INSTRUCTIONS);
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
	// The absolute and real paths, and their `~/…` forms: a task shortens a path under HOME (`shortPath`), as it does the
	// scratch folder when TMPDIR lies inside HOME.
	const both = (target: string, shown: string): Array<[string, string]> => {
		const forms = [target, fs.realpathSync(target)];
		const homed = forms.map((form) => shortPath(form)).filter((form) => form.startsWith("~"));
		return [...new Set([...forms, ...homed])].map((form): [string, string] => [form, shown]);
	};
	const octocodeSkills = getOctocodeSkillsDir();
	// Longest first, so a folder inside another is replaced before its parent.
	const replacements = [
		...both(cwd, "/workspace/project"),
		...both(agentDir, "~/.octocode/agent"),
		...both(octocodeHome, "~/.octocode/home"),
		...both(home, "~"),
		...both(root, "/tmp/octocode-context"),
		[PACKAGE_DIR, "<octocode package>"] as [string, string],
		// The Octocode skill collection lives in the installed research CLI package, wherever this machine has it.
		...(octocodeSkills ? [[octocodeSkills, "<octocode skills>"] as [string, string]] : []),
	].sort((a, b) => b[0].length - a[0].length);
	const fx = { root, cwd, home, agentDir, octocodeHome, scratch, replacements };
	// The user trusted this project: the child processes read the agent database under this Octocode home.
	trustFolder(cwd, baseEnv(fx));
	return fx;
}

/** The environment of a fresh Octocode process: nothing of the developer's own OCTOCODE_* settings or session. */
export function baseEnv(fx: Fixture): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("OCTOCODE_")) env[key] = value;
	return {
		...env,
		HOME: fx.home,
		OCTOCODE_CODING_AGENT_DIR: fx.agentDir,
		OCTOCODE_HOME: fx.octocodeHome,
		// A headless session denies every ask: the user exported workspace.
		OCTOCODE_PERMISSION: "workspace",
		OCTOCODE_MODELS_DEV: "0",
		// The default follows the machine, and the rendered tool descriptions must not.
		OCTOCODE_MAX_SUBAGENTS: "6",
		// The octocode-mcp server lists `securityCheck` and `clasify` only when the user's home enables them, and the
		// fixture home is empty. A real session declares both: opt in so the capture lists the same tools. The listing
		// makes no call; the API host is a placeholder that is never contacted.
		OCTOCODE_SECURITY_CHECKS: "1",
		OCTOCODE_CLASSIFICATION_API: "https://classification.example.invalid",
	};
}

/** Runs `run` with `env` as the whole process environment, then puts the original back. */
export async function withEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
	const saved = { ...process.env };
	const replace = (next: NodeJS.ProcessEnv) => {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, next);
	};
	replace(env);
	try {
		return await run();
	} finally {
		replace(saved);
	}
}

/** How a session is built: the main session takes the defaults, a child what its command line says. */
export interface SessionShape {
	noMcp?: boolean;
	noSkills?: boolean;
	tools?: string[];
	excludeTools?: string[];
	skillResourceSnapshot?: SkillResourceSnapshot;
	/** Settings over the defaults, e.g. `{ mcpExposure: "direct" }` to capture every tool declared in full. */
	settings?: Record<string, unknown>;
}

/**
 * A real session on the scripted model `faux/faux-1` (200,000-token window), built as the CLI builds it for `shape`, in
 * `sessionManager` (in memory by default). The caller disposes it.
 */
export async function scriptedSession(
	fx: Fixture,
	shape: SessionShape,
	sessionManager: SessionManager = SessionManager.inMemory(fx.cwd),
) {
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }],
	});
	const provider: ExtensionFactory = (api) => {
		api.registerProvider("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({
				...model,
				promptCache: { short: 300, long: 3600 },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...shape.settings });
	// The options the CLI's runtime factory (`main/runtime-factory.ts`) passes for these flags.
	const resourceLoader = new DefaultResourceLoader({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		settingsManager,
		extensionFactories: [{ name: "faux-provider", factory: provider }],
		disabledFeatures: shape.noMcp ? ["mcp"] : undefined,
		noSkills: shape.noSkills,
		skillResourceSnapshot: shape.skillResourceSnapshot,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		resourceLoader,
		settingsManager,
		sessionManager,
		...(shape.tools ? { tools: shape.tools } : {}),
		...(shape.excludeTools ? { excludeTools: shape.excludeTools } : {}),
	});
	try {
		await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
	} catch (error) {
		session.dispose?.();
		throw error;
	}
	return { session, faux };
}

/** A real session on a scripted model; returns the system message, tools and messages of its first request. */
async function firstRequest(fx: Fixture, shape: SessionShape, request: string) {
	const { session, faux } = await scriptedSession(fx, shape);
	try {
		let captured: TranscriptContext | undefined;
		faux.setResponses([
			(context: TranscriptContext) => {
				captured ??= context;
				return fauxAssistantMessage("ready");
			},
		]);
		await session.prompt(request);
		if (!captured) throw new Error("The scripted model received no request");
		return captured;
	} finally {
		session.dispose?.();
	}
}

function normalizer(fx: Fixture) {
	return (text: string): string => {
		let result = text;
		for (const [from, to] of fx.replacements) result = result.split(from).join(to);
		// The `environment` section: the machine and the day.
		return (
			result
				.replace(/^Platform: .*$/gm, "Platform: <platform> <arch>")
				.replace(/^Shell: .*$/gm, "Shell: <shell>")
				.replace(/^Date: .*$/gm, "Date: <yyyy-mm-dd>")
				// The bash tool's CLI guide: the probed host and its platform's notes (`octocode/files/bash/cli-guide.ts`).
				.replace(/^Host: .*$/gm, "Host: <os> <arch>. On PATH: <probed tools>. gh: <status>.")
				.replace(/^Host notes: .*$/gm, "Host notes: <platform notes>")
		);
	};
}

function describeRequest(
	name: string,
	kind: AgentContext["kind"],
	role: string | undefined,
	context: TranscriptContext,
	normalize: (text: string) => string,
): AgentContext {
	const system = getCurrentSystemMessage(context.messages);
	const sections = Object.entries(system?.sections ?? {}).map(([sectionName, text]) => ({
		name: sectionName,
		text: normalize(String(text)),
	}));
	const loose = system ? contentText(system.content) : "";
	if (loose) sections.unshift({ name: "(system text outside a section)", text: normalize(loose) });
	return {
		name,
		kind,
		...(role ? { role } : {}),
		sections,
		tools: getCurrentTools(context.messages).map((tool) => ({
			name: tool.name,
			description: normalize(tool.description ?? ""),
			parameters: JSON.parse(normalize(JSON.stringify(tool.parameters ?? null))) as unknown,
			strict: strictResolution(tool),
		})),
		// The system messages are the prompt and tool deltas shown above; these are the conversation.
		messages: context.messages
			.filter((message) => message.role !== "system")
			.map((message) => {
				const content = (message as { content?: unknown }).content;
				const text = Array.isArray(content)
					? content
							.map((part: { type?: string; text?: string }) =>
								part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
							)
							.join("\n")
					: String(content ?? "");
				return { role: message.role, text: normalize(text) };
			}),
	};
}

/** The main session as the user starts it: native tools, the Octocode MCP server, bundled skills and a project AGENTS.md. */
export async function captureMain(settings?: Record<string, unknown>): Promise<AgentContext> {
	const fx = fixture();
	try {
		const context = await withEnv(baseEnv(fx), () => firstRequest(fx, { settings }, MAIN_REQUEST));
		return describeRequest("main", "main", undefined, context, normalizer(fx));
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

/** A parent hands this same catalog to each sibling; scoped to one fixture pair, never cached globally. */
export interface ParentSkillCatalog {
	snapshot?: SkillResourceSnapshot;
}

/**
 * A child as `subagents/tool.ts` starts it: the identity and role prompt reach it through its environment
 * (`subagentProcessEnv`), the tools, extensions and skills through its command line (`buildAgentArgs`), the skills
 * through the snapshot file the parent wrote, and the task through `childTaskInput` and `withIdentity`. `isolated`
 * starts it in a worktree folder of the project (its own trusted copy of AGENTS.md), as `isolation.ts` hands one over.
 */
export async function captureChild(
	name: string,
	roleName: string | undefined,
	parent: { task: string; goal: string } = { task: CHILD_TASK, goal: CHILD_GOAL },
	{
		isolated = false,
		settings,
		parentSkills,
	}: { isolated?: boolean; settings?: Record<string, unknown>; parentSkills?: ParentSkillCatalog } = {},
): Promise<AgentContext> {
	const fx = fixture();
	try {
		const worktree = isolated ? path.join(fx.root, "worktrees", "child-example") : undefined;
		if (worktree) {
			fs.mkdirSync(worktree, { recursive: true });
			fs.writeFileSync(path.join(worktree, "AGENTS.md"), PROJECT_INSTRUCTIONS);
			trustFolder(worktree, baseEnv(fx));
		}
		const profiles = loadProfiles(fx.cwd, fx.home, false, {});
		const profile: AgentProfile | undefined = roleName ? profiles.get(roleName) : undefined;
		if (roleName && !profile) throw new Error(`Bundled role ${roleName} not found`);
		const skillPlan = taskSkillPlan(profile, undefined);
		// What the parent hands over: its skill catalog (a lean child gets none, and reads them inlined in its task).
		const snapshot =
			parentSkills?.snapshot ??
			(await withEnv(baseEnv(fx), async () => {
				const parent = new DefaultResourceLoader({
					cwd: fx.cwd,
					agentDir: fx.agentDir,
					settingsManager: SettingsManager.inMemory({}),
					disabledFeatures: ["mcp", "llama.cpp"],
					// The core skills a real parent gets from the Octocode extension (`registerSkills`), so a role can name one.
					additionalSkillPaths: bundledSkillDirs(),
					noPromptTemplates: true,
					noThemes: true,
				});
				await parent.reload();
				// Named skills resolve through the parent's skill commands, as `extension-bindings.ts` supplies them at runtime.
				const commands: SlashCommandInfo[] = getSkillCommands(parent.getSkills().skills).map(({ skill, name }) => ({
					name,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				}));
				return captureSkillResourceSnapshot(parent.getSkills(), skillPlan.names, commands);
			}));
		if (parentSkills) parentSkills.snapshot = snapshot;
		const snapshotFile = path.join(fx.octocodeHome, "skills-snapshot.json");
		fs.writeFileSync(snapshotFile, JSON.stringify(snapshot), { mode: 0o600 });
		const identity: Identity = {
			id: "child-example",
			role: profile?.name ?? GENERAL_PROFILE,
			goal: parent.goal,
			parentId: "parent-example",
			parentSession: "parent-session-example",
			scratch: fx.scratch,
			skillsInTask: skillPlan.inTask,
			permission: { mode: "workspace", grants: [] },
			// `isolation.ts`: the child runs in the worktree (its resolved path) and its prompt names the main checkout.
			...(worktree
				? {
						isolation: { path: worktree, repo: fx.cwd, cwd: fs.realpathSync(worktree) },
						workspace: fx.cwd,
					}
				: {}),
		};
		// A role's skills name their files in its prompt; where the research package is installed is the machine's.
		for (const skill of adoptSkillResourceSnapshot(snapshot).skills) {
			const dir = path.dirname(skill.baseDir);
			if (!dir.startsWith(PACKAGE_DIR) && !fx.replacements.some(([from]) => from === dir))
				fx.replacements.unshift([dir, "<octocode skills>"]);
		}
		const rolePrompt = withRoleSkills(profile, skillPlan.roleSkills, snapshot)?.prompt;
		const rolePromptFile = rolePrompt ? writeRolePrompt(rolePrompt, fx.octocodeHome) : undefined;
		const env = subagentProcessEnv(profile, baseEnv(fx), identity, undefined, rolePromptFile, snapshotFile);
		const skillText = skillPlan.inTask ? taskSkillText(snapshot, skillPlan.inline) : "";
		const task = withIdentity(
			childTaskInput(parent.task, { referenced: "", browserMode: profile?.headless, skillText }),
			// A real start always names the run mode (`subagents/spawn.ts`); these show the background one.
			{ ...identity, background: true },
		);
		const parsed = parseArgs(
			buildAgentArgs(profile, undefined, { dir: path.join(fx.scratch, "session"), id: identity.id }, []),
		);
		const shape: SessionShape = {
			noMcp: parsed.noMcp,
			noSkills: parsed.noSkills,
			tools: parsed.tools,
			excludeTools: parsed.excludeTools,
			// `main.ts` adopts the file only in a subagent that was handed one.
			skillResourceSnapshot: readSkillResourceSnapshot(snapshotFile),
			settings,
		};
		const runIn = identity.isolation ? { ...fx, cwd: identity.isolation.cwd } : fx;
		const context = await withEnv(env, () => firstRequest(runIn, shape, task));
		return describeRequest(name, "child", roleName, context, normalizer(fx));
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

/** The agents whose context is captured, in the order of the index. */
export const AGENTS: Array<{ name: string; role?: string; kind: AgentContext["kind"]; about: string }> = [
	{
		name: "main",
		kind: "main",
		about: "The session the user talks to: native tools, the Octocode MCP server, skills and project AGENTS.md.",
	},
	{ name: "general", kind: "child", about: "A subagent started without a role." },
	...["researcher", "implementer", "reviewer", "browser", "lean"].map((role) => ({
		name: role,
		role,
		kind: "child" as const,
		about: `A subagent started with the bundled \`${role}\` role.`,
	})),
];

/**
 * Starts every agent in turn (the process environment is swapped for each) and returns what its first request holds.
 * `settings` apply to every agent's session over the defaults.
 */
export async function captureAll(settings?: Record<string, unknown>): Promise<AgentContext[]> {
	const contexts: AgentContext[] = [];
	for (const agent of AGENTS)
		contexts.push(
			agent.kind === "main"
				? await captureMain(settings)
				: await captureChild(agent.name, agent.role, undefined, { settings }),
		);
	return contexts;
}
