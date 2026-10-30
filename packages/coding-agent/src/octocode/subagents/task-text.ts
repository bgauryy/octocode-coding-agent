import { PARENT_FENCE_NOTE } from "../shared/fence.ts";
import {
	findReferences,
	type MessageReader,
	referenceContext,
	referencedContentBlock,
	resolveReferences,
} from "../shared/references.ts";
import type { ResultContract } from "./result-schema.ts";

/**
 * The `## Referenced content` section for the references (`msg#<N>`, `report:<agent-id>`) a task cites, expanded when the
 * task is built: a lean child has no tool to read them. Empty when it cites none. Throws, naming each reference that
 * cannot be resolved, so the call fails before anything is asked or started. The parent reads as the requester, and its
 * own messages keep the parent's fence note: they steer the child as the task does.
 */
export async function taskReferences(
	task: string,
	team: MessageReader & { readonly id: string | undefined },
	ctx: { sessionManager: { getEntries(): readonly unknown[] } },
	artifactAccess: "local" | "none" = "local",
): Promise<string> {
	const refs = findReferences(task);
	if (refs.length === 0) return "";
	const { resolved, errors } = await resolveReferences(refs, {
		...referenceContext(team, ctx, PARENT_FENCE_NOTE),
		artifactAccess,
	});
	if (errors.length > 0)
		throw new Error(
			`No subagent started: the task cites references that cannot be resolved: ${errors.join("; ")}. Fix or remove them; msg#<N> is a team message you sent or received, report:<agent-id> the report of a subagent this session started.`,
		);
	return referencedContentBlock(resolved);
}

/** The task text before the child's identity: the parent's task, its referenced content, browser mode, skills and result contract. */
export function childTaskInput(
	task: string,
	parts: { referenced: string; browserMode: boolean | undefined; skillText: string; resultContract?: ResultContract },
): string {
	const { referenced, browserMode, skillText, resultContract } = parts;
	const input = [task, referenced, browserMode === undefined ? "" : `Browser mode: headless=${browserMode}.`, skillText]
		.filter(Boolean)
		.join("\n\n");
	return resultContract
		? `${input}\n\nResult contract (SHA-256 ${resultContract.hash}): Return the requested result in your final answer, after the ordinary report, as exactly one final block:\nStructured result:\n\`\`\`json\n<JSON matching the schema>\n\`\`\`\nSchema: ${JSON.stringify(resultContract.schema)}`
		: input;
}
