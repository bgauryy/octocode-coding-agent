import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ExtensionUIAskView } from "../../core/features/types.ts";

/**
 * The one ask model: askUser's questions and the harness's permission prompts both describe themselves as an `AskView`,
 * which `card.ts` draws. It rides on `ctx.ui.select` as `opts.ask`; its option labels are the select's options, so hosts
 * that do not draw it keep the plain title and options.
 */
export type AskView = ExtensionUIAskView;

/** The suffix askUser's description asks the model to put on its recommended option. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;
export const isRecommended = (label: string): boolean => RECOMMENDED.test(label);

/** Body lines a collapsible body shows until expanded. */
export const PREVIEW_LINES = 3;

/**
 * The note typed in a card's inline write-in, handed from the terminal that drew the card to the code that asked: the
 * select answers with the write-in's label and the asker takes the note here instead of opening a second dialog.
 */
const writeIns = new WeakMap<AskView, string>();
export const giveWriteIn = (view: AskView, note: string): void => void writeIns.set(view, note);
export function takeWriteIn(view: AskView | undefined): string | undefined {
	if (!view) return undefined;
	const note = writeIns.get(view);
	writeIns.delete(view);
	return note;
}

const MAX_TEXT = 400;
const MAX_BODY = 20_000;
const MAX_LINES = 12;
const clean = (value: unknown, max = MAX_TEXT): string | undefined =>
	typeof value === "string" ? sanitizeTerminalText(value).slice(0, max) : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * A view another process sent (a subagent's select), made safe to draw: every string sanitized and bounded, and kept only
 * when its option labels are exactly the dialog's options (`drawn`, as the user will choose them) and each line it shows
 * (question, metadata, body, details) appears in the dialog's verified plain `title`, so the card shows nothing the title
 * does not. Anything else yields undefined: the dialog falls back to the plain title.
 */
export function checkedView(value: unknown, drawn: readonly string[], title: string): AskView | undefined {
	const raw = record(value);
	const question = clean(raw?.question);
	const options = Array.isArray(raw?.options) ? raw.options.map(record) : [];
	if (!raw || !question || options.length !== drawn.length) return undefined;
	// The plain title shows multi-line text whole (askUser) or folded onto one line with `⏎` (permission targets).
	const shownIn = (text: string): boolean =>
		title.includes(text.replace(/\r\n|\r|\n/g, "⏎")) || text.split(/\r\n|\r|\n/).every((line) => title.includes(line));
	const view: AskView = { question, options: [] };
	for (const [index, option] of options.entries()) {
		const label = clean(option?.label);
		if (label !== drawn[index]) return undefined;
		const description = clean(option?.description);
		view.options.push({
			label,
			...(description ? { description } : {}),
			...(option?.recommended === true ? { recommended: true } : {}),
			...(option?.tone === "danger" ? { tone: "danger" as const } : {}),
		});
	}
	const meta = Array.isArray(raw.meta) ? raw.meta.slice(0, MAX_LINES).map((line) => clean(line)) : [];
	const body = record(raw.body);
	const bodyText = clean(body?.text, MAX_BODY);
	const notes = Array.isArray(raw.notes) ? raw.notes.slice(0, MAX_LINES).map(record) : [];
	const noteTexts = notes.map((note) => clean(note?.text));
	const shown = [question, ...meta, ...noteTexts, ...(bodyText ? [bodyText] : [])];
	if (shown.some((text) => text === undefined || !shownIn(text))) return undefined;
	if (meta.length) view.meta = meta as string[];
	if (bodyText) {
		const label = clean(body?.label);
		view.body = {
			text: bodyText,
			...(label ? { label } : {}),
			...(typeof body?.previewLines === "number" ? { previewLines: Math.max(1, Math.floor(body.previewLines)) } : {}),
			...(body?.collapsible === true ? { collapsible: true } : {}),
		};
	}
	if (notes.length)
		view.notes = notes.map((note, index) => ({
			text: noteTexts[index] as string,
			tone: note?.tone === "warning" ? "warning" : "muted",
		}));
	const writeIn = record(raw.writeIn);
	const writeLabel = clean(writeIn?.label);
	if (writeLabel && drawn.includes(writeLabel)) {
		const placeholder = clean(writeIn?.placeholder);
		view.writeIn = { label: writeLabel, title: clean(writeIn?.title) ?? "", ...(placeholder ? { placeholder } : {}) };
	}
	if (raw.multiSelect === true) view.multiSelect = true;
	return view;
}
