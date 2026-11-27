import type { Question, ToolDisplay } from "@octocodeai/octocode-contracts";
import { choice, confirm, text } from "../../../ask/question.ts";
import { clip } from "../../../shared/text.ts";

/** What a `render` call carries, as the tool's schema declares it. */
export interface RenderParams {
	type: "status" | "table" | "confirm" | "form";
	title: string;
	body?: string;
	rows?: string[][];
	fields?: { id: string; label: string; options?: string[] }[];
	permission?: boolean;
}

const MAX_FIELDS = 6;
const MAX_ROWS = 50;
const MAX_COLUMNS = 8;
const MAX_CELL = 40;
const MAX_OPTIONS = 8;
/** The id of the question that asks the user to accept before the agent goes on. */
export const PROCEED_ID = "proceed";

/** The question every type that needs the user's yes ends with: `confirm` itself, or `permission: true`. */
const proceed = (title: string, body?: string): Question => ({ ...confirm(PROCEED_ID, title, body) });

/**
 * The questions a call asks, through the same dialog askUser uses: none for a display that sets no `permission`. A form
 * field is a text question, or a choice when it lists options; `permission` adds the accept step last.
 */
export function questionsOf(params: RenderParams): Question[] {
	if (params.type === "confirm") return [proceed(params.title, params.body)];
	const accept = params.permission ? [proceed(`Proceed: ${params.title}?`, params.body)] : [];
	if (params.type !== "form") return accept;
	if (params.fields === undefined || params.fields.length === 0) throw new Error("form needs fields.");
	if (params.fields.length > MAX_FIELDS) throw new Error(`form takes at most ${MAX_FIELDS} fields.`);
	const ids = new Set<string>();
	const fields = params.fields.map((field): Question => {
		if (!field.id || field.id === PROCEED_ID || ids.has(field.id))
			throw new Error(`form field id "${field.id}" is empty, reserved or repeated.`);
		ids.add(field.id);
		const options = field.options ?? [];
		if (options.length === 0) return text(field.id, field.label);
		if (options.length < 2 || options.length > MAX_OPTIONS)
			throw new Error(`field "${field.id}" takes 2-${MAX_OPTIONS} options, or none for text.`);
		const question = choice(field.id, field.label, options, {
			writeIn: { label: "Write an answer", title: field.label },
		});
		return question;
	});
	return [...fields, ...accept];
}

/** A table as aligned plain text, bounded: the first row is the header, followed by a rule. */
function tableText(rows: readonly (readonly string[])[] | undefined): string {
	const cells = (rows ?? [])
		.slice(0, MAX_ROWS + 1)
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- cells are model output, unvalidated
		.map((row) => row.slice(0, MAX_COLUMNS).map((cell) => clip(String(cell).replace(/\s+/g, " "), MAX_CELL)));
	const widths = Array.from({ length: Math.max(0, ...cells.map((row) => row.length)) }, (_, at) =>
		Math.max(...cells.map((row) => (row[at] ?? "").length)),
	);
	const line = (row: string[]) =>
		widths
			.map((size, at) => (row[at] ?? "").padEnd(size))
			.join("  ")
			.trimEnd();
	const lines = cells.map(line);
	if (lines.length > 1) lines.splice(1, 0, widths.map((size) => "-".repeat(size)).join("  "));
	const more = (rows?.length ?? 0) - MAX_ROWS - 1;
	return [...lines, ...(more > 0 ? [`… ${more} more rows`] : [])].join("\n");
}

/** What the row shows for a call: the title, a status body or a table, and the call's result line. */
export function displayOf(params: Partial<RenderParams>, result: string | undefined, failed: boolean): ToolDisplay {
	const body = params.type === "table" ? tableText(params.rows) : (params.body ?? "");
	const [first = "", ...rest] = (result ?? "").trim().split("\n");
	return {
		title: "Render",
		summary: [params.type, params.title].filter(Boolean).join(": "),
		kind: "other",
		...(result && first ? { outcome: { text: first, ...(failed ? { tone: "error" as const } : {}) } } : {}),
		blocks: [
			...(body ? [{ type: "text" as const, text: body }] : []),
			...(rest.join("\n").trim() ? [{ type: "text" as const, text: rest.join("\n").trim() }] : []),
		],
	};
}
