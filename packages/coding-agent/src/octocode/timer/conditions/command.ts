import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { shellSettings } from "../../files/bash-jobs/shell.ts";
import { foregroundOperations } from "../../files/bash-run.ts";
import { readOnlyRoleRefusal } from "../../permission/read-only-role.ts";
import { reservationTargets, shellParserReady } from "../../permission/shell/mutation.ts";
import { planReadOnly } from "../../permission/shell/plan-reads.ts";
import { reservationPath } from "../../shared/home.ts";
import { planConstraintActive } from "../../../core/plan-state.ts";
import { type CheckOutcome, type ConditionSpec, OUTPUT_CAP, capped, text } from "./types.ts";

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
	async check({ command }, { cwd, deps, signal }): Promise<CheckOutcome> {
		signal?.throwIfAborted();
		const ctx = deps.context();
		if (ctx && planConstraintActive(ctx.sessionManager) && !planReadOnly(command))
			return { met: false, exit: null, output: "", refused: "plan mode blocks the until-command" };
		await shellParserReady();
		const refusal = readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd);
		if (refusal) return { met: false, exit: null, output: "", refused: refusal };
		// A path can become reserved after the timer was set or since its last poll.
		for (const file of reservationTargets(command)) {
			const held = deps.reservation(reservationPath(cwd, file), file);
			if (held) return { met: false, exit: null, output: "", refused: held };
		}
		// Four UTF-8 bytes per retained character leave enough tail even when a chunk splits a code point.
		const tail = Buffer.alloc(OUTPUT_CAP * 4);
		let length = 0;
		const operations = foregroundOperations(
			shellSettings(cwd, ctx?.isProjectTrusted() ?? false),
			() => undefined,
			undefined,
			undefined,
			{ stopAtDeadline: true },
		);
		try {
			const { exitCode } = await operations.exec(command, cwd, {
				onData: (data) => {
					const incoming = data.subarray(Math.max(0, data.length - tail.length));
					const kept = Math.min(length, tail.length - incoming.length);
					tail.copyWithin(0, length - kept, length);
					tail.set(incoming, kept);
					length = kept + incoming.length;
				},
				signal,
				timeout: CHECK_TIMEOUT_SECONDS,
			});
			const exit = exitCode ?? 1;
			return { met: exit === 0, exit, output: capped(tail.toString("utf8", 0, length)) };
		} catch (error) {
			// A timeout or a spawn failure: not met this time; the next check tries again.
			signal?.throwIfAborted();
			const output = `${tail.toString("utf8", 0, length)}\n${errorMessage(error)}`;
			return { met: false, exit: null, output: capped(output.trim()) };
		}
	},
};
