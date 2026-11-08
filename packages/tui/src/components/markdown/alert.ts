import type { Token, Tokens } from "marked";

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export const ALERT_LABELS: Readonly<Record<AlertKind, string>> = {
	note: "ℹ Note",
	tip: "✦ Tip",
	important: "‼ Important",
	warning: "⚠ Warning",
	caution: "⊘ Caution",
};

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i;

/**
 * Reads a GitHub alert from a blockquote (`> [!NOTE]` on its first line): its kind and the quote's tokens without
 * the marker. Undefined for an ordinary quote.
 */
export function parseAlert(quote: Tokens.Blockquote): { kind: AlertKind; tokens: Token[] } | undefined {
	const [first, ...rest] = quote.tokens ?? [];
	if (first?.type !== "paragraph") {
		return undefined;
	}
	const [lead, ...inline] = (first as Tokens.Paragraph).tokens;
	if (lead?.type !== "text") {
		return undefined;
	}
	const match = ALERT_MARKER.exec(lead.raw);
	if (!match) {
		return undefined;
	}
	const kind = match[1].toLowerCase() as AlertKind;
	const text = lead.raw.slice(match[0].length);
	const inlineTokens: Token[] = text ? [{ ...lead, raw: text, text, tokens: undefined }, ...inline] : inline;
	if (inlineTokens.length === 0) {
		return { kind, tokens: rest };
	}
	return { kind, tokens: [{ ...first, tokens: inlineTokens }, ...rest] };
}
