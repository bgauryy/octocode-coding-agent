import { sha256Hasher } from "../../../../common/src/atomic-file.ts";
import { type Finding, type ItemFile, type Rating, type ReviewItem, worse } from "./types.ts";

/**
 * The static scan: deterministic, local, and it executes nothing. The rating starts at what the item can do (its
 * `floor`) and only rises with findings, so a pattern that misses never lowers it. A scan is not a verdict: the report
 * never says "safe". Hard rules (download-and-run, decode-and-run, hidden characters, a credential path, editing the
 * agent's own configuration) rate CRITICAL.
 */

interface Rule {
	rule: string;
	rating: Rating;
	text: string;
	test: RegExp;
}

/**
 * `npx pkg`, `bunx pkg`, `uvx pkg`, `pnpm dlx pkg`, `yarn dlx pkg`: the flags before the package, the package (never
 * starting with `-`) and its version, if any.
 */
const RUNNER =
	/\b(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx)((?:\s+-{1,2}[\w-]+)*)\s+((?:@[\w.-]+\/)?\w[\w.-]*)(@[\w.^~*-]+|==[\w.]+)?/g;

/** Whether the text runs a registry package without naming a version (`@latest` counts as none). */
function unpinned(text: string): boolean {
	for (const match of text.matchAll(RUNNER)) if (!match[3] || match[3] === "@latest") return true;
	return false;
}

/** Zero-width and bidirectional controls, the byte-order mark and the Unicode tag block: text a reader cannot see. */
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

const RULES: readonly Rule[] = [
	{
		rule: "download-and-run",
		rating: "CRITICAL",
		text: "Downloads something and runs it",
		test: /\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$?<?\(\s*(?:curl|wget)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b|\b(?:curl|wget)\b[^\n]*&&\s*(?:chmod\s+\+x|(?:ba)?sh\s)/i,
	},
	{
		rule: "decode-and-run",
		rating: "CRITICAL",
		text: "Decodes hidden text and runs it",
		test: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:ba|z)?sh\b|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(|\bexec\s*\(\s*base64\.b64decode/i,
	},
	{
		rule: "credential-path",
		rating: "CRITICAL",
		text: "Names a file that holds credentials",
		test: /(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(?:ssh\/|aws\/credentials|gnupg\/|netrc\b|npmrc\b|docker\/config\.json|kube\/config|config\/gh\/hosts\.yml)|\bid_(?:rsa|ed25519|ecdsa)\b|\bsecurity\s+find-(?:generic|internet)-password\b/i,
	},
	{
		rule: "edits-agent-config",
		rating: "CRITICAL",
		text: "Writes to the agent's settings, hooks, skills or review records",
		test: /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bwriteFile(?:Sync)?\b)[^\n]*(?:\.(?:claude|octocode|codex|cursor)\/(?:settings(?:\.local)?\.json|hooks\.json|config\.toml|mcp\.json|skills\/)|agent\.db\b)/i,
	},
	{
		rule: "instruction-override",
		rating: "HIGH",
		text: "Tells the agent to ignore its instructions or to hide something from you",
		test: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts)\b|\bdo\s+not\s+(?:tell|inform)\s+the\s+user\b|\bdo\s+not\s+mention\s+(?:this\s+)?to\s+the\s+user\b|\bwithout\s+(?:telling|informing|asking)\s+the\s+user\b|\bdisregard\s+(?:your|the)\s+(?:system\s+prompt|instructions)\b/i,
	},
	{
		rule: "sends-data",
		rating: "MEDIUM",
		text: "Sends data to a network address",
		test: /\b(?:curl|wget)\b[^\n]*(?:\s-d\b|\s--data(?:-binary|-raw)?\b|\s-F\b|\s--upload-file\b|\s-T\b|\s-X\s*(?:POST|PUT))|\bnc\s+(?:-\w+\s+)*[\w.-]+\s+\d{2,5}\b|\bfetch\s*\([^)]*method\s*:\s*["'](?:POST|PUT)/i,
	},
	{
		rule: "environment-dump",
		rating: "MEDIUM",
		text: "Reads the whole environment, which can hold secrets",
		test: /(?:^|[\s;|&(])(?:printenv|env)\s*(?:\||>)|\bJSON\.stringify\s*\(\s*process\.env\s*\)|\bdict\s*\(\s*os\.environ\s*\)/m,
	},
	{
		rule: "plain-http",
		rating: "HIGH",
		text: "Talks to a server over unencrypted http",
		test: /\bhttp:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\]|0\.0\.0\.0\b)[\w-]+(?:\.[\w-]+)+/i,
	},
];

/** sha256 over the files in name order, each name and length framed so two layouts cannot hash alike. */
export function contentHash(files: readonly ItemFile[]): string {
	const hash = sha256Hasher();
	for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		const bytes = file.bytes ?? Buffer.from(file.text, "utf8");
		hash.update(`${file.name}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

export interface ScanResult {
	hash: string;
	rating: Rating;
	findings: Finding[];
}

/** Every finding in `text`, one per rule; `where` names the file. */
export function findingsIn(text: string, where: string): Finding[] {
	const found: Finding[] = [];
	if (HIDDEN.test(text))
		found.push({ rule: "hidden-characters", rating: "CRITICAL", text: "Holds characters a reader cannot see" });
	for (const rule of RULES)
		if (rule.test.test(text)) found.push({ rule: rule.rule, rating: rule.rating, text: rule.text });
	if (unpinned(text))
		found.push({
			rule: "unpinned-package",
			rating: "HIGH",
			text: "Runs a package at whatever version the registry serves that day",
		});
	return found.map((finding) => ({ ...finding, text: `${finding.text} (${where})` }));
}

const SEVERITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

/** Scans an item's files, after the findings its builder made. */
export function scan(item: ReviewItem): ScanResult {
	const findings: Finding[] = [...(item.preset ?? [])];
	for (const file of item.files)
		for (const finding of findingsIn(file.text, file.name))
			if (!findings.some((found) => found.rule === finding.rule)) findings.push(finding);
	if (item.unreadable)
		findings.push({ rule: "unreadable", rating: "HIGH", text: `Not read in full: ${item.unreadable}` });
	findings.sort((a, b) => SEVERITY[a.rating] - SEVERITY[b.rating]);
	return {
		hash: contentHash(item.files),
		rating: findings.reduce((rating, finding) => worse(rating, finding.rating), item.floor),
		findings,
	};
}
