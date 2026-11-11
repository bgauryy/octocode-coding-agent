import { renderInstruction } from "../../core/prompt-template.ts";
import { renderPolicySection } from "../../core/system-prompt-spec.ts";

/**
 * The whole native policy of a lean child (`lean: true` profiles): a small model gets its role, its task and the lines of
 * `lean/lean.md` instead of the work, research, delegation and communication sections. The report contract the parent
 * parses rides in its task (`report.ts`). Depends only on the selected tools, so lean siblings share one cached prompt.
 */
export function leanPromptSections(input: {
	canShell: boolean;
	canSave: boolean;
	readOnly: boolean;
	agentTool?: boolean;
}): {
	lean: string;
} {
	return {
		lean: renderPolicySection("lean", () =>
			renderInstruction("sections/lean.md", { ...input, lean: true, agentTool: input.agentTool !== false }),
		),
	};
}
