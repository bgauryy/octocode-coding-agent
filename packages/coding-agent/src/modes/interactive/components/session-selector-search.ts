import { fuzzyMatch } from "@octocodeai/octocode-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The text a query searches: the transcript, or the first prompt for a quick catalog row, which has no transcript text. */
function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText || session.firstMessage} ${session.cwd}`;
}

/** The part of the search text a row shows: its name or first prompt, and where it ran. */
function getSessionTitleText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.firstMessage} ${session.cwd}`;
}

/** Whether the user named the session; generated titles and subagent goals do not count. */
export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim()) && session.nameSource === undefined;
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = errorMessage(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

function matchSession(
	session: SessionInfo,
	parsed: ParsedSearchQuery,
	text: string = getSessionSearchText(session),
): MatchResult {
	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			normalizedText ??= normalizeWhitespaceLower(text);
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

/** Whether `query` finds the session only in its transcript, not in what its row shows. */
export function isTranscriptOnlyMatch(session: SessionInfo, query: string): boolean {
	if (!query.trim()) return false;
	const parsed = parseSearchQuery(query);
	if (parsed.error) return false;
	return matchSession(session, parsed).matches && !matchSession(session, parsed, getSessionTitleText(session)).matches;
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: title and name matches first, then by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number; transcriptOnly: boolean }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({
			session: s,
			score: res.score,
			transcriptOnly: !matchSession(s, parsed, getSessionTitleText(s)).matches,
		});
	}

	scored.sort((a, b) => {
		if (a.transcriptOnly !== b.transcriptOnly) return a.transcriptOnly ? 1 : -1;
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
