import type { ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { textResult } from "../shared/util.ts";
import { NOTE_WARN_CHARS } from "./limits.ts";
import { memoryLabel } from "./query.ts";
import {
	type MEMORY_KINDS,
	MemoryError,
	type MemoryStore,
	memoryLine,
	memoryTags,
	memoryToolLine,
	refuseMemorySecrets,
	noMemory,
} from "./store.ts";

/** The `memory` tool's writes: `set` and `delete`, with the question a global or pinned change asks first. */

/** Why an agent's global or pinned change asks: the system's reason line on the card. */
const WIDE_REASON =
	"Global memories reach every workspace; pinned memories are recalled automatically within their scope.";

/** Characters of a body in a save line; a longer body ends its line with the call that reads it whole. */
const SAVED_BODY_CHARS = 60;
/** Other memories named after a save, so the agent can merge overlapping ones. */
const RELATED_COUNT = 2;

export interface MemoryWriteParams {
	op: "set" | "delete";
	scope?: "workspace" | "project" | "global" | "all";
	title?: string;
	body?: string;
	keywords?: string;
	kind?: (typeof MEMORY_KINDS)[number];
	pinned?: boolean;
}

/**
 * A write result's details: the memory it saved, updated or deleted. A save also names the `updatedAt` of the version it
 * shows, so recall counts that version as seen (`inject.ts`) and injects it again only after a later edit.
 */
interface MemoryWriteDetails {
	ids: number[];
	updated?: number[];
}

interface WriteCall {
	toolCallId: string;
	/** The memory `params.id` names, already parsed; undefined for a new memory. */
	id: number | undefined;
	params: MemoryWriteParams;
	store: MemoryStore;
	permission: Permission;
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
}

/** Saves, updates or deletes one memory. Refusals the store would raise come before any question to the user. */
export async function writeMemory({
	toolCallId,
	id,
	params,
	store,
	permission,
	ctx,
	signal,
}: WriteCall): Promise<ReturnType<typeof textResult<MemoryWriteDetails>>> {
	signal?.throwIfAborted();
	/** Asks the user before a change that reaches every later session; a denial or no one to ask refuses it. A save asks in every mode: `full` runs a `file.outside` change, and this text would steer every later session. */
	const confirmWide = async (wide: boolean, title: string, what: string[], effect: string) => {
		if (!wide) return;
		const verdict = await permission.check(ctx, {
			action: "file.outside",
			title,
			what,
			reason: WIDE_REASON,
			...(params.op === "set" ? { reasons: ["memory.wide" as const] } : {}),
			effect,
			undo: "/memory edits or deletes it",
			risk: "text this session read could steer every later session",
			toolCallId,
			cwd: ctx.cwd,
			...(signal ? { signal } : {}),
		});
		if (!verdict.allowed) throw new MemoryError(verdict.message);
	};
	const current = id === undefined ? undefined : store.get(id);
	if (id !== undefined && !current) throw noMemory(id);
	if (params.op === "delete") {
		if (current) {
			await confirmWide(
				current.scope === "global" || current.pinned,
				"Delete this shared memory?",
				[`${memoryLabel(current.id)} (${memoryTags(current)}) ${current.title}`],
				"removes a memory every later session receives",
			);
		}
		if (id === undefined) throw new Error("delete needs id.");
		signal?.throwIfAborted();
		const removed = store.delete(id, current?.updatedAt);
		return textResult(`Deleted ${memoryLine(removed)}`, { ids: [removed.id] });
	}
	if (params.scope === "all") throw new Error("set scope is workspace, project or global.");
	const global = (params.scope ?? current?.scope) === "global";
	const pinned = params.pinned ?? current?.pinned ?? false;
	// Refusals the store would raise come first, so the user is never asked about a save that then fails.
	refuseMemorySecrets(params);
	if (!current && !params.title?.trim()) throw new MemoryError("A new memory needs a title.");
	const body = params.body ?? current?.body ?? "";
	// Only what reaches every session after the change asks: unpinning or moving into the project narrows it.
	await confirmWide(
		global || pinned,
		current ? "Change this shared memory?" : "Save this shared memory?",
		[
			`${current ? `${memoryLabel(current.id)} ` : ""}(${global ? "global" : (params.scope ?? current?.scope ?? (store.workspaceId ? "workspace" : "project"))}${pinned ? ", pinned" : ""}) ${params.title ?? current?.title ?? ""}`,
			...(body ? [body] : []),
		],
		`${current ? "changes" : "saves"} a memory every later session receives`,
	);
	signal?.throwIfAborted();
	const { memory, created } = store.set(
		{
			...(id !== undefined ? { id } : {}),
			...(params.scope ? { scope: params.scope } : {}),
			...(params.kind ? { kind: params.kind } : {}),
			...(params.title !== undefined ? { title: params.title } : {}),
			...(params.body !== undefined ? { body: params.body } : {}),
			...(params.keywords !== undefined ? { keywords: params.keywords } : {}),
			...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
			author: "agent",
			sourceSession: ctx.sessionManager.getSessionId(),
		},
		undefined,
		current?.updatedAt,
	);
	// A body longer than the warning length keeps its save: an injected line is cut at `NOTE_CHARS`.
	const softMax = NOTE_WARN_CHARS;
	const long =
		memory.body.length > softMax
			? `\nKept, but the body is ${memory.body.length} chars: shorten it to under ${softMax}, the rule and why.`
			: "";
	const related = store
		.search(`${memory.title} ${memory.keywords} ${memory.body}`, "all", RELATED_COUNT, new Set([memory.id]))
		.map((hit) => `${memoryLabel(hit.id)} ${hit.title.replace(/\s+/g, " ")}`);
	const neighbours = related.length > 0 ? `\nRelated: ${related.join("; ")}` : "";
	return textResult(
		`${created ? "Saved" : "Updated"} ${memoryToolLine(memory, SAVED_BODY_CHARS)}${long}${neighbours}`,
		{ ids: [memory.id], updated: [memory.updatedAt] },
	);
}
