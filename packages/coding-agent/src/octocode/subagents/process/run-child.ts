import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { getCliInvocation } from "../../../config.ts";
import { writeRolePrompt } from "../../instructions/role.ts";
import { sessionOutputDir } from "../../shared/home.ts";
import { prepareTree } from "../../../utils/process-tree.ts";
import { requestBudgetHistory } from "../budget-history.ts";
import { writeNonceFile } from "./env.ts";
import { prepareChildResourceFiles, removeChildResourceFiles, type ChildResourceFiles } from "./handoff-files.ts";
import type { SubagentOutcome } from "./outcome.ts";
import type { ChildRun } from "./run-phase.ts";
import { superviseChild } from "./supervise.ts";

/**
 * Runs one RPC child to its report; cancellation settles it before closing stdin and stopping its process tree.
 * The child boots at once; its task waits for `ready` (`stagger.ts`). The files the child reads at start (its role
 * prompt, resources, the nonce) are written here and removed when the run ends; `superviseChild` runs the process.
 */
export async function runChild(run: ChildRun): Promise<SubagentOutcome> {
	const { profile, identity, signal, host } = run;
	if (signal?.aborted) throw new Error("Subagent cancelled");
	const history = await requestBudgetHistory(run.args, profile, identity, signal);
	if (history.exhausted) return history.exhausted;
	const { command, prefix } = getCliInvocation();
	// Windows: the helper that owns the child's job runs before the child, so no grandchild escapes the job.
	await prepareTree();
	if (signal?.aborted) throw new Error("Subagent cancelled");
	// The team signs the user's messages to this child with the nonce for as long as the child runs.
	// The secret reaches the child through an owner-only file, never its environment or arguments (`PERMISSION_NONCE_FILE_ENV`).
	let resources: ChildResourceFiles = {};
	let nonceFile: string | undefined;
	let vouched: (() => void) | undefined;
	try {
		resources = prepareChildResourceFiles(identity);
		const rolePromptFile = profile?.prompt ? writeRolePrompt(profile.prompt, sessionOutputDir("output")) : undefined;
		const nonce = randomBytes(16).toString("hex");
		nonceFile = writeNonceFile(nonce, identity.id);
		vouched = nonceFile ? host?.vouch?.(identity.id, nonce) : undefined;
		if (!nonceFile)
			host?.permission.relayNote(
				identity.id,
				"no secret file could be written for this subagent: its audit entries and permission headers are not accepted, and the user's messages to it are not signed",
			);
		return await superviseChild(run, { command, prefix, history, nonce, nonceFile, rolePromptFile, resources });
	} finally {
		try {
			vouched?.();
		} catch {
			process.stderr.write("Unable to release a subagent permission handoff\n");
		}
		if (nonceFile) {
			try {
				fs.rmSync(nonceFile, { force: true });
			} catch {
				process.stderr.write("Unable to remove a private subagent handoff file\n");
			}
		}
		removeChildResourceFiles(resources);
	}
}
