import { cleanupDays } from "../../../../common/src/env.ts";
import { renderInstruction } from "../../core/prompt-template.ts";

/**
 * Octocode guidance, added to Octocode's structured system prompt as the `octocode` sections (Octocode wraps each section
 * in tags and records only changed sections). The prose lives in `policy/*.md` (see `README.md` beside this file); this
 * file derives the flags once and renders the files.
 * Octocode already lists the active tools with their guidelines, AGENTS.md context and skills, so the policy only adds
 * judgment and routing; per-tool usage lives in each tool's description and guidelines. Octocode's base prompt already
 * sets the identity; the skills section owns when to load a skill; a child's task owns its report contract (`report.ts`).
 * It is rebuilt only when its inputs change, preserving a stable prefix; cache reuse depends on the provider. A subagent's
 * prompt carries nothing unique to that child (its id, parent and scratch folder arrive in its task), so siblings can
 * share a stable prefix.
 */
interface PromptInputs {
	/** Whether Octocode MCP tools (`mcp__octocode__*`) are reachable: declared or discoverable. */
	octocode: boolean;
	/** Subagent profile names and one-line descriptions. */
	profiles: Array<{ name: string; description: string }>;
	/** Browser specialists to use when the main session has no browser tool. */
	browserProfiles?: string[];
	/** Whether this agent can browse itself: a browser tool or the browser MCP server is selected. */
	canBrowse?: boolean;
	/** False inside a subagent: no delegation or askUser, report back to the parent. */
	canDelegate: boolean;
	/** Whether the current request exposes the agent tool. */
	canUseAgent?: boolean;
	/** Whether the current request exposes askUser: the closing summary then points a needed decision to it. */
	canAsk?: boolean;
	/** Whether a file-writing tool is selected; this does not define the role or restrict shell/MCP effects. */
	canWrite?: boolean;
	/** Profile-level read-only role, enforced separately by the permission layer. */
	readOnlyRole?: boolean;
	/** Whether a file-writing tool is active: a read-only agent may still save permitted reports and evidence. */
	canSave?: boolean;
	/** Whether `bash` is active; a read-only agent's commands must then be read-only. */
	canShell?: boolean;
	/** Whether the current request exposes the web lookup tool. */
	canWeb?: boolean;
	/** Whether MCP tools are available; their tools can write too. */
	canMcp?: boolean;
	/** Days an untouched scratch folder is kept (`OCTOCODE_CLEANUP_DAYS`; 0 keeps it); default from the environment. */
	scratchDays?: number;
}

/**
 * The research line that sends code search to Octocode MCP (the first Octocode bullet of `policy/research.md`).
 * `core/system-prompt.ts` leaves its own bash search rule out of the rules while a session's sections carry this one, so
 * only one of the two shows, whether or not the server's tools are declared yet.
 */
const OCTOCODE_SEARCH_RULE = "Use Octocode MCP (`mcp__octocode__*`) to check code before you rely on it";

/** Whether these prompt sections route code search to Octocode MCP. */
export const policyRoutesSearchToOctocode = (sections: Record<string, string | undefined>): boolean =>
	sections.octocode_research?.includes(OCTOCODE_SEARCH_RULE) === true;

/** The flags every policy file reads, derived once from the inputs. */
function policyFlags(input: PromptInputs) {
	const main = input.canDelegate;
	const readOnly = input.readOnlyRole === true;
	const shell = input.canShell !== false;
	const web = input.canWeb !== false;
	const days = input.scratchDays ?? cleanupDays();
	return {
		// Audience: the session that answers the user, or a subagent working to its task (which its parent wrote for the user).
		main,
		child: !main,
		requester: main ? "the user" : "your task",
		readOnly,
		// Tools this request holds.
		octocode: input.octocode,
		shell,
		shellWrite: shell && !readOnly,
		web,
		mcp: input.canMcp !== false,
		canSave: input.canSave ?? input.canWrite !== false,
		canAsk: Boolean(input.canAsk),
		agentTool: input.canUseAgent !== false,
		browse: Boolean(input.canBrowse) && web,
		// Combinations a template reads by name.
		gitState: !main && shell,
		closingSummary: main && !readOnly,
		// The scratch sweep's own setting.
		retention: renderInstruction("policy/scratch.md", { keepsScratch: days === 0, days, oneDay: days === 1 }),
	};
}

export function octocodePromptSections(input: PromptInputs): Record<string, string> {
	const flags = policyFlags(input);
	const render = (name: string, extra: Record<string, string> = {}) =>
		renderInstruction(`policy/${name}.md`, { ...flags, ...extra });
	const browserProfiles = (input.browserProfiles ?? []).map((name) => `\`${name}\``).join(", ");
	const profiles = input.profiles
		.map((profile) => `  - ${profile.name}${profile.description ? `: ${profile.description}` : ""}`)
		.join("\n");
	// The main session without the agent tool has no delegation section at all.
	const delegation = !flags.main
		? render("subagent")
		: flags.agentTool
			? render("delegation", { browserProfiles, profiles })
			: "";
	return {
		octocode_work: render("work"),
		octocode_research: render("research"),
		octocode_delegation: delegation,
		octocode_safety: render("safety"),
		octocode_communication: render("communication"),
	};
}

/** Complete policy text for SDK consumers and prompt inspection. */
export function octocodePrompt(input: PromptInputs): string {
	return Object.values(octocodePromptSections(input)).filter(Boolean).join("\n\n");
}
