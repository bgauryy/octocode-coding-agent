import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { recordProblem } from "../../../core/diagnostics-log.ts";
import type { FeatureSetup } from "../../../core/features/index.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { PERMISSION_ID, type PermissionMode } from "../mode.ts";
import { harnessSource, sourcedText } from "../../events/source.ts";

/**
 * Tells the model the permission mode changed: hidden and turn-neutral, so during a run Octocode appends it after the
 * current turn's results and the model reads it next. A send that fails has no awaiting caller: it goes to the problems log.
 */
export function sendModeNotice(api: Pick<FeatureSetup, "session">, mode: PermissionMode, summary: string): void {
	void Promise.resolve(
		api.session.sendMessage(
			{
				customType: PERMISSION_ID,
				content: sourcedText(
					renderPrompt("notices/permission-mode.md", { id: PERMISSION_ID, mode, summary }),
					harnessSource("permissions"),
				),
				display: false,
				details: { mode },
			},
			{ triggerTurn: false },
		),
	).catch((error: unknown) => recordProblem("permissions", `Permission mode notice not sent: ${errorMessage(error)}`));
}
