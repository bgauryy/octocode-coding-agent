/**
 * Tool-poisoning lint: text a model reads (tool, parameter, skill descriptions, server instructions) that carries hidden
 * or out-of-place instructions. A rule fires when every one of its patterns matches inside one sentence. The verbs
 * the secret and URL rules look for are imperative ("read", "send"), the voice that addresses the model; a description
 * of what the tool does ("Reads .env files") is not an instruction and passes.
 */
export interface SuspiciousRule {
	id: string;
	/** What the rule catches. */
	about: string;
	/** All must match within one sentence; the first one's match is the excerpt. */
	patterns: readonly RegExp[];
}

export interface SuspiciousMatch {
	rule: string;
	/** The match with a little context, invisible characters written as `<U+XXXX>`. */
	excerpt: string;
	/** Code points of the invisible characters in the match, for the Unicode rules. */
	codePoints?: string[];
}

/** Words that may sit between two parts of a rule: up to 160 characters, never across a sentence end. */
const GAP = String.raw`(?:[^.!?\n]|[.!?](?!\s|$)){0,160}?`;
const IMPERATIVE = String.raw`\b(?:read|cat|open|print|output|dump|collect|extract|grab|copy|retrieve|include|pass|send|attach|upload)\b`;
const SINK = String.raw`(?:\b(?:pass|send|include|attach|upload|post|forward|share|leak|exfiltrate|transmit|embed)\b|\b(?:in|into|as)\b${GAP}\b(?:parameter|param|argument|field)s?\b|https?://)`;
const SECRET_PATH = String.raw`(?:(?:~|\$HOME|%USERPROFILE%)?[\\/]\.ssh\b|\.ssh[\\/]|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.aws[\\/]credentials\b|\.git-credentials\b)`;
const SECRET_WORD = String.raw`(?:\.env\b|~[\\/]\.[\w.-]+|\b(?:credentials?|api[\s_-]?keys?|secrets?|passwords?|private[\s_-]?keys?|(?:access|auth|bearer|session)[\s_-]?tokens?|ssh[\s_-]?keys?)\b)`;
const DATA = String.raw`\b(?:conversation|chat|history|messages?|context|data|contents?|files?|results?|output|everything|credentials?|keys?|tokens?|secrets?|environment|variables|prompt|transcript|it|them)\b`;
const PRIOR = String.raw`(?:previous|prior|above|earlier|preceding|former|original|system|developer|safety)`;
const ORDERS = String.raw`(?:instructions?|prompts?|rules|directions|guidelines|guardrails)`;

/** The default rules of `analyzeSurface`'s `suspicious-instruction` issue; pass `suspiciousRules` to change them. */
export const SUSPICIOUS_RULES: readonly SuspiciousRule[] = [
	{
		id: "invisible-character",
		about:
			"zero-width and other invisible characters (U+200B, U+200C, U+200D outside emoji sequences, U+2060–U+2064, U+FEFF, U+180E): text the user cannot see",
		patterns: [/[​‌⁠-⁤﻿᠎]|(?<!(?:\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])️?)‍|‍(?!\p{Extended_Pictographic})/u],
	},
	{
		id: "bidi-control",
		about:
			"bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069) that reorder what is shown",
		patterns: [/[‪-‮⁦-⁩]/u],
	},
	{
		id: "unicode-tag",
		about:
			"tag characters (U+E0000–U+E007F), invisible ASCII look-alikes that smuggle text; a flag emoji's subdivision tags pass",
		patterns: [/(?<!\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{0,6})[\u{E0000}-\u{E007F}]/u],
	},
	{
		id: "instruction-override",
		about: 'phrases that cancel earlier instructions: "ignore previous instructions", "disregard all rules"',
		patterns: [
			new RegExp(
				String.raw`\b(?:ignore|disregard|forget|override|bypass|supersede|takes?\s+precedence\s+over)\s+(?:(?:all|any|of|the|your|my)\s+)*(?:${PRIOR}\s+(?:\w+\s+)?${ORDERS}|(?:all|any|your)\s+${ORDERS})\b`,
				"i",
			),
		],
	},
	{
		id: "conceal-from-user",
		about: 'requests to hide the call from the user: "do not tell the user", "without informing the user"',
		patterns: [
			/\b(?:(?:do\s+not|don['’]t|never|must\s+not|should\s+not)\s+(?:tell|inform|notify|alert|warn|(?:mention|reveal|show|disclose)\s+(?:\w+\s+){0,3}?to)\s+(?:the\s+)?user|without\s+(?:telling|informing|notifying|alerting|asking)\s+(?:the\s+)?user|(?:hide|conceal|keep)\s+(?:this|it)\s+(?:secret\s+|hidden\s+)?from\s+(?:the\s+)?user)\b/i,
		],
	},
	{
		id: "system-prompt",
		about: "mentions of the system prompt, which a tool has no reason to address",
		patterns: [/\bsystem[\s_-]?prompts?\b/i],
	},
	{
		id: "hidden-tag",
		about:
			"pseudo-tags that frame hidden orders (<IMPORTANT>, <SYSTEM>, <instructions>, <hidden>; not <system-reminder>) and HTML comments",
		patterns: [
			/<\/?\s*(?:important|system|instructions?|hidden|admin|critical|override|assistant)(?=[\s/>])[^>]*>|<!--/i,
		],
	},
	{
		id: "secret-path",
		about: "an imperative to read a credential file: ~/.ssh, id_rsa, id_ed25519, ~/.aws/credentials, .git-credentials",
		patterns: [new RegExp(`${IMPERATIVE}${GAP}${SECRET_PATH}`, "i")],
	},
	{
		id: "secret-exfiltration",
		about:
			"an imperative to read a secret (.env, ~/.<dotfile>, credentials, API keys, passwords, tokens) and pass it on: into a parameter, a request or a URL",
		patterns: [new RegExp(`${IMPERATIVE}${GAP}${SECRET_WORD}${GAP}${SINK}`, "i")],
	},
	{
		id: "send-to-url",
		about: "an imperative to send data (the conversation, files, results, it) to a literal URL",
		patterns: [
			new RegExp(
				String.raw`\b(?:send|post|upload|forward|transmit|exfiltrate|leak|report|submit|share|pass)\b${GAP}${DATA}${GAP}https?://`,
				"i",
			),
		],
	},
];

const UNICODE_RULES = new Set(["invisible-character", "bidi-control", "unicode-tag"]);
const FORMAT = /\p{Cf}/gu;
const CONTEXT = 30;
const MATCH_MAX = 100;

const codePoint = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
const visible = (s: string): string => s.replace(FORMAT, (ch) => `<${codePoint(ch)}>`).replace(/\s+/g, " ");

/** Sentences with their offsets: split after `.`, `!` or `?` followed by white space, and at newlines. */
function sentences(text: string): { start: number; text: string }[] {
	const out: { start: number; text: string }[] = [];
	const end = /[.!?](?=\s)|\n/g;
	let start = 0;
	for (let m = end.exec(text); m; m = end.exec(text)) {
		out.push({ start, text: text.slice(start, m.index + 1) });
		start = m.index + 1;
	}
	out.push({ start, text: text.slice(start) });
	return out;
}

function excerpt(text: string, at: number, length: number): string {
	const before = Array.from(text.slice(Math.max(0, at - CONTEXT * 2), at))
		.slice(-CONTEXT)
		.join("");
	const matched = Array.from(text.slice(at, at + length));
	const body = matched.length > MATCH_MAX ? `${matched.slice(0, MATCH_MAX).join("")}…` : matched.join("");
	const after = Array.from(text.slice(at + length, at + length + CONTEXT * 2))
		.slice(0, CONTEXT)
		.join("");
	const lead = at - before.length > 0 ? "…" : "";
	const tail = at + length + after.length < text.length ? "…" : "";
	return visible(`${lead}${before}${body}${after}${tail}`).trim();
}

/** Every rule that fires on `text`, with its first match. */
export function findSuspicious(text: string, rules: readonly SuspiciousRule[] = SUSPICIOUS_RULES): SuspiciousMatch[] {
	const found: SuspiciousMatch[] = [];
	for (const rule of rules) {
		for (const s of sentences(text)) {
			const [first, ...rest] = rule.patterns.map((p) => p.exec(s.text));
			if (!first || rest.some((m) => !m)) continue;
			const at = s.start + first.index;
			const hit: SuspiciousMatch = { rule: rule.id, excerpt: excerpt(text, at, first[0].length) };
			if (UNICODE_RULES.has(rule.id)) {
				const all = s.text.match(new RegExp(rule.patterns[0].source, "gu")) ?? [];
				hit.codePoints = [...new Set(all.map(codePoint))];
			}
			found.push(hit);
			break;
		}
	}
	return found;
}

/** The issue detail: the rule, the code points for a Unicode rule (with decoded tag text), and the excerpt. */
export function suspiciousDetail(m: SuspiciousMatch, text: string): string {
	const points = m.codePoints?.length ? ` ${m.codePoints.join(", ")};` : "";
	const tags = m.rule === "unicode-tag" ? decodeTags(text) : "";
	return `${m.rule}:${points}${tags ? ` decodes to "${tags}";` : ""} "${m.excerpt}"`;
}

/** The ASCII a run of tag characters spells (U+E0020–U+E007E map to U+0020–U+007E). */
function decodeTags(text: string): string {
	return Array.from(text)
		.map((ch) => ch.codePointAt(0)!)
		.filter((cp) => cp >= 0xe0020 && cp <= 0xe007e)
		.map((cp) => String.fromCodePoint(cp - 0xe0000))
		.join("")
		.slice(0, 80);
}
