import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/** The docs library's routes. Like the other workspace routes they sit behind the bearer capability; none takes a host path. */
export const DOCS_ROUTES = {
	index: "/api/docs",
	file: "/api/docs/file",
	/** The locally bundled Mermaid script, fetched only when a document with a diagram opens. */
	mermaid: "/api/docs/mermaid",
} as const;

/** Paths of repository documents (git-tracked Markdown outside `.octocode/`) start with this; the rest is relative to the workspace root. */
export const REPO_DOC_PREFIX = "@repo/";

export function isRepoDocPath(path: string): boolean {
	return path.startsWith(REPO_DOC_PREFIX);
}

/** What a document is, read from the `.octocode/agent/` folder (or file name) it sits in. */
export const DOC_KINDS = ["rfc", "research", "brainstorm", "review", "audit", "plan", "contract", "report"] as const;

/** Markdown in the workspace docs view. Paths are relative to `.octocode/agent/`; scratch folders are listed only on request. */
export const DocSummarySchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 300 }),
		kind: StringEnum(DOC_KINDS),
		/** The top-level folder the document sits in; empty for a file directly in `.octocode/agent/`. */
		topic: Type.String({ maxLength: 128 }),
		title: Type.String({ maxLength: 300 }),
		updated: Type.String({ minLength: 4, maxLength: 64 }),
		bytes: Type.Integer({ minimum: 0 }),
		status: Type.Optional(Type.String({ maxLength: 40 })),
		question: Type.Optional(Type.String({ maxLength: 2000 })),
	},
	{ additionalProperties: false },
);

export const DocsIndexSchema = Type.Object(
	{
		docs: Type.Array(DocSummarySchema, { maxItems: 1000 }),
		/** True when more documents exist than the list carries. */
		truncated: Type.Boolean(),
		/** True when this list includes the scratch folder `tmp/`. */
		tmp: Type.Boolean(),
		/** True when the project is not trusted, so the host left repository documents out without listing them. */
		repoDocsHidden: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const DocFileSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 300 }),
		markdown: Type.String({ maxLength: 524288 }),
	},
	{ additionalProperties: false },
);

export const MermaidScriptSchema = Type.Object({ script: Type.String() }, { additionalProperties: false });

export type DocKind = (typeof DOC_KINDS)[number];
export type DocSummary = Static<typeof DocSummarySchema>;
export type DocsIndex = Static<typeof DocsIndexSchema>;
export type DocFile = Static<typeof DocFileSchema>;
