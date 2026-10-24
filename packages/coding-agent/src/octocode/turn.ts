import type { ExtensionAPI } from "../core/extensions/index.ts";
import type { Skill } from "../core/skills.ts";
import { octocodePromptSections } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import type { OctocodeMcp } from "./mcp/octocode.ts";
import { envFlag, READ_ONLY_ENV } from "./shared/env.ts";
import { promptRootsFromEnv, rebasePath } from "./shared/prompt-root.ts";
import { visibleControls } from "./shared/sanitize.ts";
import { isOctocodeTool } from "./shared/octocode-tools.ts";
import { type AgentProfile, profileSelectsTool } from "./subagents/profiles.ts";
import { AGENT_COLLABORATE_ENV } from "./team/store/env.ts";

/** Adds the cached native prompt section without changing the session's selected tools. */
export function registerTurnSetup(
	pi: ExtensionAPI,
	options: {
		isSubagent: boolean;
		profiles: () => Map<string, AgentProfile>;
		octocode: Pick<OctocodeMcp, "owner" | "ready" | "instructions">;
	},
): { reset(): void } {
	let prompt: Record<string, string> | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	const readOnlyRole = options.isSubagent && envFlag(process.env, READ_ONLY_ENV);
	const promptRoots = options.isSubagent ? promptRootsFromEnv(process.env) : undefined;

	pi.on("before_agent_start", async (event, ctx) => {
		const selected = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
		// Connecting may register tools after the core took its snapshot. Only those new tools extend it;
		// a connected server must not undo an explicit tool deselection on a later turn.
		const before = new Set(pi.getActiveTools());
		const owner = options.octocode.owner(ctx);
		if (owner.by === "extension") await options.octocode.ready(ctx);
		const available = [...selected, ...pi.getActiveTools().filter((name) => !before.has(name))];
		// Deferred tools are reachable through discovery even before a tool is loaded.
		const indirect = available.includes("tool_search")
			? pi
					.getAllTools()
					.filter((tool) => isOctocodeTool(tool.name) && !available.includes(tool.name) && tool.exposure === "deferred")
			: [];
		// A server from the user's mcp.json may still be connecting when the prompt is built; the prompt says how to recover
		// when a tool turns out to be missing, so an enabled configured server counts as reachable (and the prompt stays cached).
		const octocode =
			available.some(isOctocodeTool) ||
			indirect.length > 0 ||
			(owner.by === "user" && owner.enabled && canReachMcp(available));
		const instructions = octocode ? (options.octocode.instructions ?? octocodeNamespaceInstructions(pi)) : undefined;
		// Every deferred Octocode tool, loaded or not, so loading one does not change the section.
		const deferredTools = available.includes("tool_search")
			? pi
					.getAllTools()
					.filter((tool) => isOctocodeTool(tool.name) && tool.exposure === "deferred")
					.map((tool) => tool.name.replace(/^mcp__octocode__/, ""))
					.sort()
			: [];
		// A read-only role keeps `file` for its reports; its profile, not its tools, says it leaves source unchanged.
		const canWrite = !readOnlyRole && ["file", "write", "edit"].some((name) => selected.includes(name));
		const profiles = [...options.profiles().values()];
		const inputs = {
			octocode,
			profiles: profiles.map(({ name, description }) => ({ name, description })),
			browserProfiles:
				!options.isSubagent && selected.includes("agent") && !selected.includes("browser")
					? profiles.filter((profile) => profileSelectsTool(profile, "browser", [])).map(({ name }) => name)
					: [],
			canDelegate: !options.isSubagent,
			canUseAgent: selected.includes("agent"),
			canWrite,
			readOnlyRole,
			canSave: ["file", "write", "edit"].some((name) => selected.includes(name)),
			canShell: selected.includes("bash") || selected.includes("powershell"),
			canWeb: selected.includes("web"),
			// Availability follows the connected servers; a global MCP opt-out still applies.
			canMcp: available.some((name) => name.startsWith("mcp__") || name === "mcp" || name === "tool_search"),
			...(octocode && instructions ? { octocodeInstructions: instructions } : {}),
			...(octocode && deferredTools.length > 0 ? { octocodeDeferredTools: deferredTools } : {}),
			// Subagent-only, and the same for every child of one run mode: nothing per-child may enter the prompt.
			...(options.isSubagent && envFlag(process.env, AGENT_COLLABORATE_ENV) ? { collaborate: true } : {}),
		};
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = octocodePromptSections(inputs);
		}
		// A named section (not a whole-prompt override) lets Octocode record a small transcript delta.
		Object.assign(event.systemPromptOptions.sections, prompt);
		if (role !== undefined) event.systemPromptOptions.sections.role = role;
		if (promptRoots) {
			// An isolated child's prompt names the main checkout, so siblings share the cached prefix. Tools and
			// permissions keep the real worktree cwd; the task text names it.
			event.systemPromptOptions.cwd = rebasePath(event.systemPromptOptions.cwd, promptRoots);
			event.systemPromptOptions.contextFiles = event.systemPromptOptions.contextFiles.map((file) => ({
				...file,
				path: rebasePath(file.path, promptRoots),
			}));
		}
		if (options.isSubagent) {
			// Keep skill routing metadata; task-specific bodies are read only when needed.
			event.systemPromptOptions.sections.docs = "";
			event.systemPromptOptions.skills = childSkills(event.systemPromptOptions.skills ?? []);
		}
		return undefined;
	});

	return {
		reset() {
			prompt = undefined;
			promptKey = undefined;
		},
	};
}

/** Whether this session can reach MCP tools at all: declared, through discovery or from scripts. */
const canReachMcp = (available: readonly string[]): boolean =>
	available.some((name) => name.startsWith("mcp__") || name === "tool_search");

/** The server instructions an Octocode server from the user's mcp.json gave its tools' namespace, if any. */
function octocodeNamespaceInstructions(pi: Pick<ExtensionAPI, "getAllTools">): string | undefined {
	const text = pi.getAllTools().find((tool) => isOctocodeTool(tool.name) && tool.namespace?.instructions)
		?.namespace?.instructions;
	return text ? visibleControls(text).trim() || undefined : undefined;
}

/** Copy the skill metadata so child prompt preparation cannot mutate the loader's catalog. */
export function childSkills(skills: readonly Skill[]): Skill[] {
	return skills.map((skill) => ({ ...skill }));
}
