import type { MemoryScope, Row } from "../../../../db/src/api.ts";
import { storedSecret } from "@octocodeai/octocode-common/sanitize";
import { stringOrEmpty } from "../shared/util.ts";
import { MemoryError } from "./errors.ts";

/** One memory row as the store hands it out, and the input a save takes: the leaf the store and its search share. */

/** `reference`: a pointer to something outside the repository (a URL, dashboard or ticket). */
export const MEMORY_KINDS = ["preference", "fact", "decision", "gotcha", "procedure", "reference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const isMemoryKind = (value: unknown): value is MemoryKind => MEMORY_KINDS.some((kind) => kind === value);
export interface Memory {
	id: number;
	scope: MemoryScope;
	repoKey: string | null;
	kind: MemoryKind;
	title: string;
	body: string;
	keywords: string;
	pinned: boolean;
	author: string;
	sourceSession: string | null;
	createdAt: number;
	updatedAt: number;
	lastUsed: number | null;
	useCount: number;
}

/** A search hit: `score` is higher-is-better (negated BM25, or the LIKE fallback's IDF-weighted column match). */
export interface MemoryHit extends Memory {
	score: number;
}

export interface MemoryInput {
	scope?: MemoryScope;
	kind?: MemoryKind;
	title?: string;
	body?: string;
	keywords?: string;
	pinned?: boolean;
}

/** Refuses title, body or keywords that look like a secret. Checked on the sanitized text, the form that is stored: an invisible character must not split a token past it. */
export function refuseMemorySecrets(input: Pick<MemoryInput, "title" | "body" | "keywords">): void {
	const found = storedSecret({ title: input.title, body: input.body, keywords: input.keywords });
	if (found)
		throw new MemoryError(`Refused: this looks like a secret (${found.problem}). Never store credentials in memory.`);
}

export function toMemory(row: Row): Memory {
	return {
		id: Number(row.id),
		scope: row.scope as MemoryScope,
		repoKey: (row.repo_key as string | null) ?? null,
		kind: row.kind as MemoryKind,
		title: stringOrEmpty(row.title),
		body: stringOrEmpty(row.body),
		keywords: stringOrEmpty(row.keywords),
		pinned: Number(row.pinned) === 1,
		author: stringOrEmpty(row.author),
		sourceSession: (row.source_session as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		lastUsed: row.last_used == null ? null : Number(row.last_used),
		useCount: Number(row.use_count ?? 0),
	};
}
