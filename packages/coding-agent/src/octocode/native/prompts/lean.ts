import { renderPolicySection, renderSectionChunks } from "../../../core/system-prompt-spec.ts";

/**
 * The whole native policy of a lean agent, instead of the work, research, delegation and communication sections: a
 * lean child (`lean: true` profiles) gets its role, its task and the lines of `lean/lean.md`, and its report contract
 * rides in its task (`report.ts`); a lean main session (`turn.ts`: a small window or a small-tier model) gets the same
 * rules addressed to the user's session, with no delegation. Depends only on the selected tools and the audience, so
 * lean siblings share one cached prompt.
 */
export function leanPromptSections(input: {
	canShell: boolean;
	canSave: boolean;
	readOnly: boolean;
	agentTool?: boolean;
	/** The main session, which answers the user and starts no children; a child otherwise. */
	main?: boolean;
}): {
	lean: string;
} {
	const main = input.main === true;
	return {
		lean: renderPolicySection("lean", () =>
			renderSectionChunks("lean", {
				...input,
				main,
				// A main session is never read-only, and its paths are not reserved by a coordinator.
				readOnly: !main && input.readOnly,
				lean: true,
				agentTool: input.agentTool !== false,
			}),
		),
	};
}
