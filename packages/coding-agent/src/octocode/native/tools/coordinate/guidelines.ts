import { renderPrompt } from "../../../../core/prompt-template.ts";
import { envFlag, LEAN_ENV } from "@octocodeai/octocode-common/env";
import { readOnlyRole } from "../../../permission/read-only-role.ts";

/** The `coordinate` guideline lines: a read-only role (reviewer, researcher, browser) gets no lock, unlock or edit guidance. */
export function coordinateGuidelines(subagent: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
	return renderPrompt("tools/coordinate/guidelines.md", {
		subagent,
		lean: envFlag(env, LEAN_ENV),
		readOnly: readOnlyRole(env),
	})
		.split("\n")
		.filter((line) => line.trim() !== "");
}
