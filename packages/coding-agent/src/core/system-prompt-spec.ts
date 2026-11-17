import { instructionSource } from "./prompt-template.ts";

/**
 * Every known system prompt section: its order, cache tier, owner and what a custom prompt (`SYSTEM.md`, SDK
 * `customPrompt`) does to it, as the table in `instructions/sections/index.md` declares them. Producers fill section contents through `BuildSystemPromptOptions`
 * (their defaults) or `before_agent_start` `sections`/`baseSections`; only `composeSystemPromptSections` orders them.
 */

export interface SystemPromptSectionSpec {
	name: string;
	/**
	 * `base`: depends only on the tools and the install, so sessions in other projects or on other days share it (the
	 * first instruction cache block). `session`: stable for a session but project- or role-specific (the second cache
	 * block). `volatile`: differs between sessions of one project or changes during one (the working directory, the
	 * date, plan mode, MCP connection state), so it comes last, in a block without a cache breakpoint.
	 */
	tier: "base" | "session" | "volatile";
	/** The module that writes the content. */
	owner: string;
	/** Under a custom prompt: `replace` takes the custom text, `drop` leaves the default out, `keep` is unchanged. */
	underCustomPrompt: "replace" | "drop" | "keep";
	/** Sections rendered together from `sections/<name>.md`: `policy` or `lean`. */
	group?: string;
}

type SystemPromptSectionTier = SystemPromptSectionSpec["tier"];

/** The rows of the map's table, past its header and divider. */
function parseSectionMap(markdown: string): SystemPromptSectionSpec[] {
	return markdown
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.slice(2)
		.map((line) => {
			const [name, tier, underCustomPrompt, group, owner] = line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			return {
				name,
				tier: tier as SystemPromptSectionTier,
				owner,
				underCustomPrompt: underCustomPrompt as SystemPromptSectionSpec["underCustomPrompt"],
				...(group === "-" ? {} : { group }),
			};
		});
}

/** Every known section in prompt order, from `instructions/sections/index.md`. Unknown extension sections take the two slots named in `composeSystemPromptSections`. */
export const SYSTEM_PROMPT_SECTIONS: readonly SystemPromptSectionSpec[] = parseSectionMap(
	instructionSource("sections/index.md"),
);

const SPECS = new Map(SYSTEM_PROMPT_SECTIONS.map((spec) => [spec.name, spec]));

/**
 * Sections composed as a family: the head (text before the first member) keeps the family's name, and each member
 * (one MCP server's block, one instruction file, one environment field) becomes its own `<family>:<key>` section at
 * the family's place. A change to one member then patches only that member, and a new member adds one section. The
 * pattern matches the first line of a member and captures its key.
 */
const SECTION_FAMILIES: Readonly<Record<string, RegExp>> = {
	mcps: /^<mcp name="([^"]*)"/,
	project_context: /^<project_instructions path="([^"]*)"/,
	environment: /^([A-Za-z][A-Za-z ]*): /,
};

/** The family a section belongs to: the name before `:` for a family member, else the name itself. */
function sectionFamily(name: string): string {
	const colon = name.indexOf(":");
	return colon > 0 && name.slice(0, colon) in SECTION_FAMILIES ? name.slice(0, colon) : name;
}

/** The section's spec (a family member's is its family's), or undefined for a name only an extension writes. */
export function systemPromptSectionSpec(name: string): SystemPromptSectionSpec | undefined {
	return SPECS.get(sectionFamily(name));
}

/** A set of section names that also holds every member of a family it holds. */
class SectionNameSet extends Set<string> {
	override has(name: string): boolean {
		return super.has(sectionFamily(name));
	}
}

/** Known sections outside the base tier: the first one present starts the second instruction cache block. */
export const NON_BASE_SECTIONS: ReadonlySet<string> = new SectionNameSet(
	SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.tier !== "base").map((spec) => spec.name),
);

/** Volatile sections: the first one present starts the trailing instruction block, which has no cache breakpoint. */
export const VOLATILE_SECTIONS: ReadonlySet<string> = new SectionNameSet(
	SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.tier === "volatile").map((spec) => spec.name),
);

/**
 * A family's whole text as the model reads it (`mcps`, `project_context`): its head and members, in order; for any
 * other name (a member, a plain section) that section alone. Empty when absent.
 */
export function sectionFamilyText(sections: Readonly<Record<string, string | null>>, family: string): string {
	return Object.entries(sections)
		.filter(([name, text]) => text !== null && (name === family || sectionFamily(name) === family))
		.map(([, text]) => text)
		.join("\n\n");
}

/** Split a family's raw content into its head and members, keyed by section name; duplicate keys stay in one member. */
function splitFamily(family: string, text: string, memberStart: RegExp): Array<[string, string]> {
	const parts = new Map<string, string[]>([[family, []]]);
	let current = parts.get(family)!;
	for (const line of text.split("\n")) {
		const key = memberStart.exec(line)?.[1];
		if (key !== undefined) {
			const name = `${family}:${family === "environment" ? key.toLowerCase() : key}`;
			current = parts.get(name) ?? [];
			parts.set(name, current);
		}
		current.push(line);
	}
	return [...parts].flatMap(([name, lines]) => {
		const part = lines.join("\n").trim();
		return part ? [[name, part] as [string, string]] : [];
	});
}

/**
 * A policy section could not be rendered. Unlike any other handler error, `before_agent_start` does not contain this
 * one (`features/runner/emit-transforms.ts`): the run fails with it, because a session without its policy sections
 * would otherwise start and look healthy.
 */
export class PolicyRenderError extends Error {
	constructor(section: string, cause: unknown) {
		super(
			`The \`${section}\` prompt section failed to render (${cause instanceof Error ? cause.message : String(cause)}). The session does not start without its policy: fix the instruction template.`,
			{ cause },
		);
		this.name = "PolicyRenderError";
	}
}

/** Render one policy section (or the values its templates read), turning any failure into a `PolicyRenderError` that names it. */
export function renderPolicySection<T>(section: string, render: () => T): T {
	try {
		return render();
	} catch (error) {
		throw error instanceof PolicyRenderError ? error : new PolicyRenderError(section, error);
	}
}

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/** Throw for a name that cannot be a tag, or for `preamble`, which only the prompt itself sets. */
export function assertSystemPromptSectionName(name: string): void {
	if (!SECTION_NAME.test(name) || name === "preamble") throw new Error(`Invalid system prompt section name: ${name}`);
}

/**
 * Order raw section contents by the spec and wrap every section but `preamble` in a tag of its name, so the model can
 * match later updates to it. The preamble stays bare: a custom prompt's text must begin the prompt byte for byte. Unknown names in `extensionBase` follow the known base sections, in their given order;
 * other unknown names end the session tier, before the volatile one. Empty contents are left out. A family section
 * (`SECTION_FAMILIES`) becomes its head and one section per member, each wrapped in the family's tag, so the model
 * reads every member as part of `<mcps>`, `<project_context>` or `<environment>`.
 */
export function composeSystemPromptSections(
	contents: Readonly<Record<string, string>>,
	extensionBase: ReadonlySet<string> = new Set(),
): Record<string, string> {
	const present = Object.entries(contents).filter(([, text]) => text.length > 0);
	const unknown = present.filter(([name]) => !SPECS.has(name));
	const slots: Record<SystemPromptSectionTier, Array<[string, string]>> = { base: [], session: [], volatile: [] };
	for (const spec of SYSTEM_PROMPT_SECTIONS) {
		const text = contents[spec.name];
		if (!text) continue;
		const memberStart = SECTION_FAMILIES[spec.name];
		slots[spec.tier].push(
			...(memberStart ? splitFamily(spec.name, text, memberStart) : [[spec.name, text] as [string, string]]),
		);
	}
	slots.base.push(...unknown.filter(([name]) => extensionBase.has(name)));
	slots.session.push(...unknown.filter(([name]) => !extensionBase.has(name)));
	const sections: Record<string, string> = {};
	for (const [name, text] of [...slots.base, ...slots.session, ...slots.volatile]) {
		const tag = sectionFamily(name);
		sections[name] = name === "preamble" ? text : `<${tag}>\n${text}\n</${tag}>`;
	}
	return sections;
}
