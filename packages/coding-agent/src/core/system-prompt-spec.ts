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

/** The section's spec, or undefined for a name only an extension writes. */
export function systemPromptSectionSpec(name: string): SystemPromptSectionSpec | undefined {
	return SPECS.get(name);
}

/** Known sections outside the base tier: the first one present starts the second instruction cache block. */
export const NON_BASE_SECTIONS: ReadonlySet<string> = new Set(
	SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.tier !== "base").map((spec) => spec.name),
);

/** Volatile sections: the first one present starts the trailing instruction block, which has no cache breakpoint. */
export const VOLATILE_SECTIONS: ReadonlySet<string> = new Set(
	SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.tier === "volatile").map((spec) => spec.name),
);

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
 * other unknown names end the session tier, before the volatile one. Empty contents are left out.
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
		if (text) slots[spec.tier].push([spec.name, text]);
	}
	slots.base.push(...unknown.filter(([name]) => extensionBase.has(name)));
	slots.session.push(...unknown.filter(([name]) => !extensionBase.has(name)));
	const sections: Record<string, string> = {};
	for (const [name, text] of [...slots.base, ...slots.session, ...slots.volatile])
		sections[name] = name === "preamble" ? text : `<${name}>\n${text}\n</${name}>`;
	return sections;
}
