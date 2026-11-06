import { Type, type Static } from "typebox";
import { isRecord } from "./guards.ts";

/** Public source references; opaque provider continuation tokens are deliberately not display data. */
export const ContentAnnotationSchema = Type.Object({
	type: Type.String(),
	title: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	text: Type.Optional(Type.String()),
	startIndex: Type.Optional(Type.Number()),
	endIndex: Type.Optional(Type.Number()),
	fileId: Type.Optional(Type.String()),
	documentIndex: Type.Optional(Type.Number()),
	startPage: Type.Optional(Type.Number()),
	endPage: Type.Optional(Type.Number()),
});
export type ContentAnnotation = Static<typeof ContentAnnotationSchema>;

/** An opaque, session-scoped reference. Consumers never receive host filesystem authority. */
export const ApplicationAssetSchema = Type.Object({
	id: Type.String(),
	mimeType: Type.String(),
	size: Type.Integer({ minimum: 0 }),
	/** Changes when a streaming asset's current value is replaced. Final assets are immutable. */
	revision: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
});
export type ApplicationAsset = Static<typeof ApplicationAssetSchema>;
export interface ApplicationAssetPayload {
	asset: ApplicationAsset;
	encoding: "base64" | "utf8";
	data: string;
}
export interface ApplicationAssetInput {
	mimeType: string;
	data: string;
	name?: string;
}
export const APPLICATION_UPLOAD_BYTES = 20 * 1024 * 1024;
export const APPLICATION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const ApplicationAssetInputSchema = Type.Object(
	{
		mimeType: Type.Union(APPLICATION_IMAGE_MIME_TYPES.map((mime) => Type.Literal(mime))),
		data: Type.String({ minLength: 1, maxLength: Math.ceil(APPLICATION_UPLOAD_BYTES / 3) * 4 }),
		name: Type.Optional(Type.String({ maxLength: 255 })),
	},
	{ additionalProperties: false },
);

const id = { id: Type.String() };
const expandedText = {
	text: Type.String(),
	/** Present when text is a preview; fetch this asset to read all of it. */
	full: Type.Optional(ApplicationAssetSchema),
};
export const ApplicationContentBlockSchema = Type.Union([
	Type.Object({
		...id,
		type: Type.Literal("text"),
		...expandedText,
		annotations: Type.Optional(Type.Array(ContentAnnotationSchema)),
	}),
	Type.Object({ ...id, type: Type.Literal("thinking"), ...expandedText, redacted: Type.Optional(Type.Boolean()) }),
	Type.Object({ ...id, type: Type.Literal("image"), asset: ApplicationAssetSchema }),
	Type.Object({
		...id,
		type: Type.Literal("media"),
		mimeType: Type.String(),
		asset: Type.Optional(ApplicationAssetSchema),
		uri: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
	}),
	Type.Object({
		...id,
		type: Type.Literal("resource"),
		uri: Type.String(),
		mimeType: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		full: Type.Optional(ApplicationAssetSchema),
	}),
	Type.Object({
		...id,
		type: Type.Literal("toolCall"),
		toolCallId: Type.String(),
		name: Type.String(),
		arguments: Type.Unknown(),
	}),
	Type.Object({ ...id, type: Type.Literal("unsupported"), providerType: Type.String(), ...expandedText }),
]);
export type ApplicationContentBlock = Static<typeof ApplicationContentBlockSchema>;

/** Text-only consumers get an explicit description for every non-text block. */
export function applicationContentText(content: readonly ApplicationContentBlock[]): string {
	return content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.redacted ? "[Reasoning redacted]" : block.text;
				case "image":
					return `[Image: ${block.asset.name ?? block.asset.mimeType}]`;
				case "media":
					return `[Media: ${block.name ?? block.mimeType}]`;
				case "resource":
					return block.text || `[Resource: ${block.name ?? block.uri}]`;
				case "toolCall":
					return `[Tool call: ${block.name}]`;
				case "unsupported":
					return block.text || `[Unsupported content: ${block.providerType}]`;
			}
		})
		.join("\n");
}

/** What one query row (or the result itself, without `row`) states a call was for, as the tool's own data returned it. */
export interface ReturnedPurpose {
	/** The row's own `index` when it is a number, else its array position; absent for the result's top level. */
	row?: number;
	mainGoal?: string;
	reasoning?: string;
}

function purposeText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `mainGoal`, and `reasoning` (else `reason`), of the first of `records` that states each. */
function statedPurpose(records: Record<string, unknown>[]): Pick<ReturnedPurpose, "mainGoal" | "reasoning"> {
	const first = (keys: string[]) => {
		for (const record of records)
			for (const key of keys) {
				const text = purposeText(record[key]);
				if (text) return text;
			}
		return undefined;
	};
	const mainGoal = first(["mainGoal"]);
	const reasoning = first(["reasoning"]) ?? first(["reason"]);
	return { ...(mainGoal ? { mainGoal } : {}), ...(reasoning ? { reasoning } : {}) };
}

/**
 * Every goal and reasoning an external tool's result states for its call, for display: the server's data (the
 * `structuredContent` of the stored MCP result, else the value itself) at its top level, then per row of its top-level
 * arrays, a row's own text before its `data`'s. Rows carry their `index`, else their position; empty values and whole
 * duplicate entries are dropped. Empty when the result states none; the call's own arguments are never consulted, since
 * an external tool's input is not ours to annotate. The text is the server's, untrimmed beyond its outer whitespace.
 */
export function returnedPurposes(structuredContent: unknown): ReturnedPurpose[] {
	if (!isRecord(structuredContent)) return [];
	const data = isRecord(structuredContent.structuredContent) ? structuredContent.structuredContent : structuredContent;
	const entries: ReturnedPurpose[] = [{ ...statedPurpose([data]) }];
	for (const value of Object.values(data)) {
		if (!Array.isArray(value)) continue;
		value.forEach((row, position) => {
			if (!isRecord(row)) return;
			const index = row.index;
			entries.push({
				row: typeof index === "number" && Number.isFinite(index) ? index : position,
				...statedPurpose(isRecord(row.data) ? [row, row.data] : [row]),
			});
		});
	}
	const seen = new Set<string>();
	return entries.filter((entry) => {
		if (entry.mainGoal === undefined && entry.reasoning === undefined) return false;
		const key = JSON.stringify([entry.row, entry.mainGoal, entry.reasoning]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The first goal, else the first reasoning, a result states: the one line a tool row shows under its title. */
export function returnedPurpose(structuredContent: unknown): string | undefined {
	const purposes = returnedPurposes(structuredContent);
	return purposes.find((entry) => entry.mainGoal)?.mainGoal ?? purposes.find((entry) => entry.reasoning)?.reasoning;
}

/** The rows of a purpose block, in the order every surface (terminal, web, export) draws them. */
export interface PurposeLayout {
	/** Whether one goal is shared by every row: rows then carry only their reasoning, listed as bullets. */
	shared: boolean;
	/** The shared goal, stated once above the rows; absent when it is already shown elsewhere (`shown`). */
	goal?: string;
	/** Per row: its reasoning when the goal is shared, otherwise its goal, its reasoning or both. */
	rows: ReturnedPurpose[];
	/** Whether each row is labelled with its number: always for per-row goals, with two or more rows otherwise. */
	numbered: boolean;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Lays out `purposes` for display. One distinct goal across rows becomes the layout's shared `goal` with a row per
 * reasoning; several goals stay with their rows. A goal or reasoning equal to `shown`, the text already drawn as the
 * tool row's one-line reason, is left out, and a row with nothing left is dropped. The text itself is untouched.
 */
export function layoutPurposes(purposes: readonly ReturnedPurpose[], shown?: string): PurposeLayout {
	const skip = shown === undefined ? undefined : squash(shown);
	const keep = (text: string | undefined) => (text !== undefined && squash(text) !== skip ? text : undefined);
	const goals = new Set(purposes.flatMap((entry) => (entry.mainGoal ? [squash(entry.mainGoal)] : [])));
	const shared = goals.size === 1;
	const rows = purposes.flatMap((entry): ReturnedPurpose[] => {
		const mainGoal = shared ? undefined : keep(entry.mainGoal);
		const reasoning = keep(entry.reasoning);
		if (mainGoal === undefined && reasoning === undefined) return [];
		return [
			{
				...(entry.row === undefined ? {} : { row: entry.row }),
				...(mainGoal ? { mainGoal } : {}),
				...(reasoning ? { reasoning } : {}),
			},
		];
	});
	const goal = shared ? keep(purposes.find((entry) => entry.mainGoal)?.mainGoal) : undefined;
	const numbered = shared ? rows.filter((row) => row.row !== undefined).length >= 2 : true;
	return { shared, ...(goal ? { goal } : {}), rows, numbered };
}
