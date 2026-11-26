import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { registeredWorkspaceDb } from "../../../storage/workspace-database.ts";
import { BacklogError } from "../../backlog/item.ts";
import { SIGNATURE_EVIDENCE } from "../../backlog/signature.ts";
import { BacklogStore } from "../../backlog/store.ts";
import type { MemoryStore } from "../store.ts";
import { MEMORY_LINE_MAX_CHARS } from "./format.ts";

/**
 * A reflection lesson about a tool or harness defect belongs to the code that has it, so the reply may carry one
 * `defect`: code files a proposed backlog item (state `backlog`, for the user or coordinator to accept) and may add the
 * workaround line, tagged with the item (`(fix B12)`). A later consolidation evicts the line once the item is done.
 */

const TAG = (ref: string) => ` (fix ${ref})`;
/** A workaround line's tag: the backlog item whose completion makes the line obsolete. */
const FIX_TAG = /\s*\(fix (B\d+)\)\s*$/;

const DefectSchema = Type.Object(
	{
		/** What to fix, in the owner's terms. */
		title: Type.String({ minLength: 8, maxLength: 120 }),
		/** What happened: the call or message that showed the defect. */
		trigger: Type.String({ minLength: 8, maxLength: 400 }),
		/** The error's `archive` signature, when the session showed one. */
		signature: Type.Optional(Type.String({ minLength: 3, maxLength: 160 })),
		/** The workaround for the meantime, as a Gotchas line of the workspace file. */
		line: Type.Optional(Type.String({ minLength: 8, maxLength: MEMORY_LINE_MAX_CHARS - TAG("B999999").length })),
	},
	{ additionalProperties: false },
);
export type Defect = Static<typeof DefectSchema>;

/** The reply's `defects` key: none, or one defect; throws, naming the problem, on anything else. */
export function parseDefects(value: unknown): Defect | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("defects is not a list");
	if (value.length > 1) throw new Error(`the reply has ${value.length} defects, over the 1 allowed`);
	if (value.length === 0) return undefined;
	if (Value.Check(DefectSchema, value[0])) return value[0];
	const errors = [...Value.Errors(DefectSchema, value[0])]
		.slice(0, 3)
		.map((error) => `${error.instancePath || "/"} ${error.message}`);
	throw new Error(`Invalid defect: ${errors.join("; ")}`);
}

/** The line `defect` adds beside its item `ref`. */
export const taggedLine = (defect: Defect, ref: string): string | undefined =>
	defect.line ? `${defect.line.replace(/\s+/g, " ").trim()}${TAG(ref)}` : undefined;

/** The item a line waits on (`(fix B12)` at its end), if it has one. */
export const fixItemOf = (text: string): string | undefined => FIX_TAG.exec(text)?.[1];

const backlogOf = (store: MemoryStore, env: NodeJS.ProcessEnv): BacklogStore | undefined => {
	const agent = store.workspaceId && registeredWorkspaceDb(store.workspaceId, env)?.agent;
	return agent && store.workspaceId ? new BacklogStore(() => agent, store.workspaceId) : undefined;
};

const OPEN = ["backlog", "todo", "ongoing"] as const;

/**
 * Files `defect` as a proposed item and returns its ref, or the ref of an open item with the same title (one item per
 * defect). Without a workspace there is no board and nothing is filed. A refused item (a secret in the text) is returned
 * as `refused`, not thrown, so the pass's other changes still apply.
 */
export function proposeDefect(
	store: MemoryStore,
	defect: Defect,
	context: { session: string; env: NodeJS.ProcessEnv },
): { ref: string } | { refused: string } | undefined {
	const board = backlogOf(store, context.env);
	if (!board) return undefined;
	const existing = board.list({ states: OPEN, title: defect.title }).items[0];
	if (existing) return { ref: existing.ref };
	try {
		const item = board.add({
			title: defect.title,
			goal: "The defect is fixed in its owner: the error no longer occurs, and the workaround line leaves MEMORY.md.",
			why: `Found by a session-end reflection: ${defect.trigger}`,
			state: "backlog",
			...(defect.signature ? { evidence: [`${SIGNATURE_EVIDENCE}${defect.signature}`] } : {}),
			createdBy: "agent:reflection",
			sourceSession: context.session,
		});
		return { ref: item.ref };
	} catch (error) {
		if (error instanceof BacklogError) return { refused: error.message };
		throw error;
	}
}

/** Whether the item behind a `(fix B12)` tag is done (a closed item is done underneath). */
export function fixChecker(store: MemoryStore, env: NodeJS.ProcessEnv): (ref: string) => boolean {
	const board = backlogOf(store, env);
	return (ref) => board?.get(ref)?.state === "done";
}
