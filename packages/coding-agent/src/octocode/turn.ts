import type { ExtensionAPI, ExtensionContext } from "../core/extensions/index.ts";
import { octocodePrompt } from "./instructions/policy.ts";
import { readRolePrompt } from "./instructions/role.ts";
import type { OctocodeMcp } from "./mcp/octocode.ts";
import { envFlag } from "./shared/env.ts";
import { isOctocodeTool } from "./shared/octocode-tools.ts";
import { type AgentProfile, profileSelectsTool } from "./subagents/profiles.ts";
import { AGENT_COLLABORATE_ENV } from "./team/store.ts";

/** Whether a subagent started with this profile gets the `browser` tool. */
export function profileHasBrowser(profile: AgentProfile): boolean {
	return profileSelectsTool(profile, "browser", ["browser"]);
}

/**
 * The session's starting tool set, or undefined when nothing changes. A main session leaves
 * `browser` (the largest schema, paid on every request) to the subagent profiles that carry it, when any does. Tools
 * the user named on purpose stay.
 */
export function sessionTools(
	active: readonly string[],
	explicit: ReadonlySet<string>,
	delegateBrowser: boolean,
): string[] | undefined {
	return delegateBrowser && active.includes("browser") && !explicit.has("browser")
		? active.filter((name) => name !== "browser")
		: undefined;
}

/**
 * At session start the tool set is settled once (see sessionTools; later tool changes are the user's). Each turn
 * adds the `octocode` prompt section, rebuilt only when its inputs change so the provider cache holds. The active
 * tool set is Octocode's: it is never rewritten per turn.
 */
export function registerTurnSetup(
	pi: ExtensionAPI,
	options: {
		isSubagent: boolean;
		profiles: () => Map<string, AgentProfile>;
		octocode: Pick<OctocodeMcp, "owner" | "ready" | "instructions">;
	},
): { reset(): void; settleTools(ctx: Pick<ExtensionContext, "explicitToolNames">): void } {
	let prompt: string | undefined;
	let promptKey: string | undefined;
	const role = options.isSubagent ? readRolePrompt() : undefined;
	/** Why the session started. A `/reload` keeps Octocode's active tools (the user may have changed them), so it settles nothing. */
	let startReason: string | undefined;
	pi.on("session_start", async (event) => {
		startReason = event.reason;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const selected = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
		// Connecting may register tools after the core took its snapshot. Only those new tools extend it;
		// a connected server must not undo an explicit tool deselection on a later turn.
		const before = new Set(pi.getActiveTools());
		const owner = options.octocode.owner(ctx);
		if (owner.by === "extension") await options.octocode.ready(ctx);
		const available = [...selected, ...pi.getActiveTools().filter((name) => !before.has(name))];
		const octocode = available.some(isOctocodeTool);
		const instructions = octocode ? options.octocode.instructions : undefined;
		const canWrite = ["file", "write", "edit"].some((name) => selected.includes(name));
		const inputs = {
			octocode,
			profiles: [...options.profiles().values()].map(({ name, description }) => ({ name, description })),
			canDelegate: !options.isSubagent,
			canUseAgent: selected.includes("agent"),
			canWrite,
			canShell: selected.includes("bash") || selected.includes("powershell"),
			// A profile with `mcp: false` starts its child with MCP switched off and without Octocode's MCP (`subagents/process`).
			canMcp: available.some((name) => name.startsWith("mcp__") || name === "mcp" || name === "tool_search"),
			...(octocode && instructions ? { octocodeInstructions: instructions } : {}),
			// Subagent-only, and the same for every child of one run mode: nothing per-child may enter the prompt.
			...(options.isSubagent && envFlag(process.env, AGENT_COLLABORATE_ENV) ? { collaborate: true } : {}),
		};
		const key = JSON.stringify(inputs);
		if (prompt === undefined || key !== promptKey) {
			promptKey = key;
			prompt = octocodePrompt(inputs);
		}
		// A named section (not a whole-prompt override) lets Octocode record a small transcript delta.
		event.systemPromptOptions.sections.octocode = prompt;
		if (role !== undefined) event.systemPromptOptions.sections.role = role;
		return undefined;
	});

	return {
		reset() {
			prompt = undefined;
			promptKey = undefined;
		},
		/** Once per session (not on a reload), after its profiles load: settle the starting tool set. */
		settleTools(ctx) {
			if (startReason === "reload") return;
			const delegateBrowser =
				!options.isSubagent &&
				pi.getActiveTools().includes("agent") &&
				[...options.profiles().values()].some(profileHasBrowser);
			const next = sessionTools(
				pi.getActiveTools(),
				new Set([
					...(ctx.explicitToolNames ?? []),
					...(pi.getSettings().defaultTools ?? [])
						.map((entry) => entry.trim())
						.filter((entry) => !entry.startsWith("-"))
						.map((entry) => entry.replace(/^\+/, "")),
				]),
				delegateBrowser,
			);
			if (next) pi.setActiveTools(next);
		},
	};
}
