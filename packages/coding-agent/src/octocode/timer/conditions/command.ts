import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { shellSettings } from "../../files/bash-jobs/shell.ts";
import { foregroundOperations } from "../../files/bash-run.ts";
import { readOnlyRoleRefusal } from "../../permission/read-only-role.ts";
import { shellParserReady } from "../../permission/shell/mutation.ts";
import { planReadOnly } from "../../permission/shell/plan-reads.ts";
import { planConstraintActive } from "../../../core/plan-state.ts";
import { type CheckOutcome, type ConditionSpec, capped, text } from "./types.ts";

/** How long one until-command check may run before it counts as not met. */
const CHECK_TIMEOUT_SECONDS = 60;

type Command = { kind: "command"; command: string };

/**
 * `command` exits 0. It runs on the bash tool's foreground path, after the rules a bash call meets at that moment: plan
 * mode runs only read-only commands, and a read-only role none that change files (the call that set the timer passed the
 * full permission check).
 */
export const commandSpec: ConditionSpec<Command> = {
	kind: "command",
	parse: (value) => ({ kind: "command", command: text(value, "until.command") }),
	encode: (condition) => condition.command,
	decode: (stored) => ({ kind: "command", command: stored }),
	describe: (condition) => `\`${condition.command}\` exits 0`,
	safetyMs: 15_000,
	pollMs: 15_000,
	async check({ command }, { cwd, deps }): Promise<CheckOutcome> {
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
	},
};
