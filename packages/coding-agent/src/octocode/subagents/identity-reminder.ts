import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type ChildIdentity, identityBlock } from "../instructions/task.ts";
import { existingLibrary } from "../history/archive.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { AGENT_ID_ENV } from "../team/store/env.ts";
import { IDENTITY_REMINDER_TYPE, latestReminderOnly } from "../shared/reminder-view.ts";
import type { ResultContract } from "./result-schema.ts";
import { browserModeLine, resultContractBlock } from "./task-text.ts";

/**
 * A child's identity after compaction. The parent appends the child's identity (`instructions/task.ts` `identityBlock`:
 * its id, goal, item, scratch folder, worktree, run mode and report contract) to each task it sends, at the spawn and at
 * every task resume, and passes that assignment in `SUBAGENT_ASSIGNMENT_ENV` (`assignmentText`: the identity plus the
 * task's browser mode, skill pointers and result contract, each from its owning renderer). The child records it as a hidden
 * session entry when it changes, so the record holds the latest assignment the caller made (a message to a lingering
 * run sends none and keeps it). A compaction may leave the task message only behind a saved-file reference, so after
 * each one the latest recorded text follows the summary as one hidden message at the end of the context: it rewrites
 * neither the system text nor the messages before it (the compaction itself changed the transcript; how much of the
 * prefix a provider's cache reuses is up to the provider). A quick second compaction can keep the previous reminder in
 * its retained tail; requests show only the latest reminder, so an earlier (possibly replaced) assignment is not read
 * again, and no prefix a provider can still reuse changes (the new summary precedes it). A resumed or forked parent
 * reopens the same child session, so the entry travels with it.
 */

/** The parent's archive library, which the child's identity names when there is one. */
export function parentArchive(): { library: string } | undefined {
	const library = existingLibrary();
	return library ? { library } : undefined;
}

/**
 * What the child is reminded of after a compaction: its identity, then the browser mode, the skills the task listed by
 * name and location (inlined skill bodies are not repeated: which loaded skills a child keeps is not tracked) and the result
 * contract, each rendered as the task rendered it. The task's own text stays with the summary.
 */
export function assignmentText(
	identity: ChildIdentity,
	archive: { library: string } | undefined,
	parts: { browserMode: boolean | undefined; skillText: string; resultContract?: ResultContract },
	inlineSkills: boolean,
): string {
	const skills = inlineSkills ? "" : parts.skillText;
	const extras = [browserModeLine(parts.browserMode), skills, resultContractBlock(parts.resultContract)];
	return [identityBlock(identity, archive), ...extras].filter(Boolean).join("\n\n");
}

/** The child's latest assignment (`assignmentText`), set by the parent for each run it starts. */
export const SUBAGENT_ASSIGNMENT_ENV = "OCTOCODE_SUBAGENT_ASSIGNMENT";

export const IDENTITY_ENTRY = "octocode-subagent-identity";
export { IDENTITY_REMINDER_TYPE };

interface IdentityRecord {
	version: 1;
	/** The child the text names; an entry for another id is not this child's. */
	id: string;
	text: string;
}

function identityRecord(data: unknown, id: string): IdentityRecord | undefined {
	return isRecord(data) && data.version === 1 && data.id === id && typeof data.text === "string" && data.text !== ""
		? { version: 1, id, text: data.text }
		: undefined;
}

/** The latest valid identity record on `branch` for child `id`. */
function latestIdentity(branch: readonly SessionEntry[], id: string): IdentityRecord | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry.type !== "custom" || entry.customType !== IDENTITY_ENTRY) continue;
		const record = identityRecord(entry.data, id);
		if (record) return record;
	}
	return undefined;
}

/** Registers the child's identity record and its reminder; a session that is not a subagent run records nothing. */
export function registerIdentityReminder(api: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const id = env[AGENT_ID_ENV];
	const assigned = env[SUBAGENT_ASSIGNMENT_ENV];
	if (!id) return;
	const record = (ctx: Pick<ExtensionContext, "sessionManager">) => {
		if (!assigned || latestIdentity(ctx.sessionManager.getBranch(), id)?.text === assigned) return;
		api.appendEntry(IDENTITY_ENTRY, { version: 1, id, text: assigned } satisfies IdentityRecord);
	};
	api.on("session_start", async (_event, ctx) => record(ctx));
	api.on("session_compact", async (_event, ctx) => {
		const latest = latestIdentity(ctx.sessionManager.getBranch(), id);
		if (!latest) return;
		try {
			void api.sendMessage(
				{ customType: IDENTITY_REMINDER_TYPE, content: latest.text, display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		} catch (error) {
			if (!isStaleSessionError(error)) throw error;
		}
	});
	api.on("context", async (event) => {
		const messages = latestReminderOnly(event.messages);
		return messages === event.messages ? undefined : { messages };
	});
}
