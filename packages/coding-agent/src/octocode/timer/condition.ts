import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ExtensionContext } from "../../core/features/index.ts";
import { shellSettings } from "../files/bash-jobs/shell.ts";
import { foregroundOperations } from "../files/bash-run.ts";
import { readOnlyRoleRefusal } from "../permission/read-only-role.ts";
import { planReadOnly } from "../permission/shell/plan-reads.ts";
import { shellParserReady } from "../permission/shell/mutation.ts";
import { planConstraintActive } from "../plan/state.ts";
import { type CheckOutcome, OUTPUT_CAP, type TimerCondition } from "./model.ts";

/** How long one until-command check may run before it counts as not met. */
const CHECK_TIMEOUT_SECONDS = 60;

const capped = (text: string) => (text.length > OUTPUT_CAP ? `…${text.slice(-OUTPUT_CAP)}` : text);

export interface ConditionDeps {
	/** Why `absolute` may not be changed now (another agent's reservation), or undefined: the team's own check. */
	reservation(absolute: string, display: string): string | undefined;
	/** The session the check runs for: its plan mode and project trust apply. */
	context(): ExtensionContext | undefined;
}

/**
 * Checks a timer's condition. `unlocked` asks the team whether another agent reserves the path. `command` runs on the bash
 * tool's foreground path, after the rules a bash call meets at that moment: plan mode runs only read-only commands, and a
 * read-only role none that change files (the call that set the timer passed the full permission check).
 */
export function conditionChecker(deps: ConditionDeps) {
	return async (condition: TimerCondition, cwd: string): Promise<CheckOutcome> => {
		if (condition.kind === "unlocked") {
			const absolute = path.resolve(cwd, condition.path);
			const held = deps.reservation(absolute, condition.path);
			return { met: held === undefined, exit: null, output: held ?? `${condition.path} is not reserved.` };
		}
		const { command } = condition;
		const ctx = deps.context();
		if (ctx && planConstraintActive(ctx.sessionManager) && !planReadOnly(command))
			return { met: false, exit: null, output: "", refused: "plan mode blocks the until-command" };
		await shellParserReady();
		const refusal = readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd);
		if (refusal) return { met: false, exit: null, output: "", refused: refusal };
		const chunks: Buffer[] = [];
		const operations = foregroundOperations(
			shellSettings(cwd, ctx?.isProjectTrusted() ?? false),
			() => undefined,
			undefined,
			undefined,
			{ stopAtDeadline: true },
		);
		try {
			const { exitCode } = await operations.exec(command, cwd, {
				onData: (data) => chunks.push(data),
				timeout: CHECK_TIMEOUT_SECONDS,
			});
			const exit = exitCode ?? 1;
			return { met: exit === 0, exit, output: capped(Buffer.concat(chunks).toString("utf8")) };
		} catch (error) {
			// A timeout or a spawn failure: not met this time; the next check tries again.
			const output = `${Buffer.concat(chunks).toString("utf8")}\n${errorMessage(error)}`;
			return { met: false, exit: null, output: capped(output.trim()) };
		}
	};
}
