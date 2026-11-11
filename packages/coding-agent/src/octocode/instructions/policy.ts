import { resolveRetention } from "../../storage/retention.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { renderPolicySection, SYSTEM_PROMPT_SECTIONS } from "../../core/system-prompt-spec.ts";
import type { ResolvedRoles } from "../../../../mcp/src/api.ts";

/** The research server the policy routes code search to: its namespace prefix and full tool names, by role. */
export type ResearchContext = Pick<NonNullable<ResolvedRoles["research"]>, "prefix" | "reader" | "search">;

/**
 * Octocode guidance, added to Octocode's structured system prompt as the `octocode` sections (Octocode wraps each section
 * in tags and records only changed sections). `sections/index.md` lists them and `sections/<name>.md` composes each
 * from its parts (see `README.md` beside this file); this file derives the flags once and renders those templates.
 * Octocode already lists the active tools with their guidelines, AGENTS.md context and skills, so the policy only adds
 * judgment and routing; per-tool usage lives in each tool's description and guidelines. Octocode's base prompt already
 * sets the identity; the skills section owns when to load a skill; a child's task owns its report contract (`report.ts`).
 * It is rebuilt only when its inputs change, preserving a stable prefix; cache reuse depends on the provider. A subagent's
 * prompt carries nothing unique to that child (its id, parent and scratch folder arrive in its task), so siblings can
 * share a stable prefix.
 */
interface PromptInputs {
	/** The research MCP server, from its entry's roles, when this agent can reach it: the research section then routes code search to it and names its tools. */
	research?: ResearchContext | undefined;
	/** Subagent profile names and one-line descriptions, with the model each runs on when known. */
	profiles: Array<{ name: string; description: string; model?: string | undefined }>;
	/** The coordinator's model, providers and purpose routes, frozen per session (`subagents/routing-watch.ts`). */
	routing?:
		| { sessionModel: string; providers: Array<{ id: string; count: number }>; small: string; medium: string }
		| undefined;
	/** Browser specialists to use when the main session has no browser tool. */
	browserProfiles?: string[];
	/** False inside a subagent: no delegation, report back to the parent. */
	canDelegate: boolean;
	/** Whether the current request exposes the agent tool. */
	canUseAgent?: boolean;
	/** Whether that tool declares its `external` type. */
	canExternal?: boolean;
	/** Profile-level read-only role of a subagent (the main session never is one), enforced separately by the permission layer. */
	readOnly?: boolean;
	/** Whether a file-writing tool is active (default true): a read-only agent may still save permitted reports and evidence. */
	canSave?: boolean;
	/** Whether `bash` is active; a read-only agent's commands must then be read-only. */
	canShell?: boolean;
	/** Whether the research server's file reader is declared (default true): the research section names it only then. */
	canReadLocal?: boolean;
	/** Whether the tool that asks the user is declared (default true). */
	canAsk?: boolean;
	/** Whether the current request exposes the web lookup tool. */
	canWeb?: boolean;
	/** Whether the `backlog` and `backlogPlan` tools are declared (default true): delegation plans and waits on items only then. */
	canBacklog?: boolean;
	/**
	 * Whether this session has started a child or messaged another agent (`turn.ts`): the `children` section, the rules
	 * for running children and using their reports, is sent from then on and is absent before.
	 */
	childStarted?: boolean;
	/** Whether MCP tools are available; their tools can write too. */
	canMcp?: boolean;
	/** Whether this agent drives its own isolated browser: its profile declares `browser.control` and it holds the browser server. */
	browserControl?: boolean;
	/** Days an untouched scratch folder is kept (`retention.days`; 0 keeps it); default from `resolveRetention`. */
	scratchDays?: number;
}

/** The flags every policy file reads, derived once from the inputs. */
function policyFlags(input: PromptInputs) {
	const main = input.canDelegate;
	// Only a subagent is read-only: `turn.ts` derives the input from the child's profile.
	const readOnly = input.readOnly === true && !main;
	const shell = input.canShell !== false;
	const web = input.canWeb !== false;
	const days = input.scratchDays ?? resolveRetention().days;
	const research = input.research;
	const bare = (tool: string) =>
		`\`${research && tool.startsWith(research.prefix) ? tool.slice(research.prefix.length) : tool}\``;
	const search = (research?.search ?? []).map(bare);
	return {
		// Audience: the session that answers the user, or a subagent working to its task (which its parent wrote for the user).
		main,
		// A lean child renders `lean.ts` instead of these sections; shared partials read the flag.
		lean: false,
		requester: main ? "the user" : "your task",
		readOnly,
		// Tools this request holds.
		research: research !== undefined,
		"research.prefix": research?.prefix ?? "",
		"research.reader": research ? bare(research.reader) : "",
		"research.search": search.length > 1 ? `${search.slice(0, -1).join(", ")} or ${search.at(-1)}` : (search[0] ?? ""),
		shell,
		web,
		mcp: input.canMcp !== false,
		localReader: input.canReadLocal !== false,
		askUser: input.canAsk !== false,
		backlog: input.canBacklog !== false,
		browserControl: input.browserControl === true,
		canSave: input.canSave !== false,
		agentTool: input.canUseAgent !== false,
		childStarted: input.childStarted === true,
		externalAgent: input.canExternal === true,
		// Combinations a template reads by name.
		gitState: !main && shell,
		// The scratch sweep's own setting.
		retention: renderInstruction("policy/scratch.md", { keepsScratch: days === 0, days, oneDay: days === 1 }),
	};
}

/** A model route in backticks, or as prose when it is a routing error. */
const quote = (value: string) => (/\s/.test(value) ? value : `\`${value}\``);

/** A provider with how many of its models can run a task: `openai` (41). */
export const providerCount = ({ id, count }: { id: string; count: number }): string => `${quote(id)} (${count})`;

/** Throws `PolicyRenderError` when a section's template does not render: the caller must not go on without the policy. */
export function octocodePromptSections(input: PromptInputs): Record<string, string> {
	const routing = input.routing;
	const values = {
		...renderPolicySection("policy", () => policyFlags(input)),
		browserProfiles: (input.browserProfiles ?? []).map((name) => `\`${name}\``).join(", "),
		profiles: input.profiles
			.map(
				(profile) =>
					`  - ${profile.name}${profile.model ? ` (${quote(profile.model)})` : ""}${profile.description ? `: ${profile.description}` : ""}`,
			)
			.join("\n"),
		providers: routing ? routing.providers.map(providerCount).join(", ") : "",
		sessionModel: routing ? quote(routing.sessionModel) : "",
		smallRoute: routing ? quote(routing.small) : "",
		mediumRoute: routing ? quote(routing.medium) : "",
	};
	return Object.fromEntries(
		SYSTEM_PROMPT_SECTIONS.filter((section) => section.group === "policy").map(({ name }) => [
			name,
			renderPolicySection(name, () => renderInstruction(`sections/${name}.md`, values)),
		]),
	);
}

/** Complete policy text for SDK consumers and prompt inspection: every section, `children` included. */
export function octocodePrompt(input: PromptInputs): string {
	return Object.values(octocodePromptSections({ childStarted: true, ...input }))
		.filter(Boolean)
		.join("\n\n");
}
