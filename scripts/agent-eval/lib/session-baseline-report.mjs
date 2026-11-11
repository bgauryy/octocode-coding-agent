/** The stored-session baseline (`session-baseline.mjs`) as a compact Markdown report. */

import { CHARS_PER_TOKEN, REASON_KEY_TOKENS, roleToolCalls, share } from "./session-baseline.mjs";

const percent = (value) => (value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
const count = (value) => value.toLocaleString("en-US");
const table = (head, rows) =>
	[
		`| ${head.join(" | ")} |`,
		`| ${head.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");

/** The baseline as a compact Markdown report. `githubTools` are the tool names whose per-role use decides step T2. */
export function renderBaseline(baseline, { source, githubTools = [] } = {}) {
	const { scope, children, reason, reports, skills, memory } = baseline;
	const out = [
		"# Stored-session baseline",
		"",
		`Source: ${source ?? "fixture rows"}. ${count(scope.sessions)} stored transcripts; ${count(scope.measured)} measured (${count(scope.requests)} requests); ${count(scope.excluded)} left out (scripted model, or a temporary directory).`,
		"",
		"## Cache read share per day and role",
		"",
		"Measured: requests, prompt tokens, cache read. Estimated: the instructions and history split (the prefix is the session's first prompt size; a cache read covers the prefix first).",
		"",
		table(
			["day", "role", "requests", "cache read", "instructions", "history", "first request"],
			baseline.cache.map((row) => [
				row.day,
				row.role,
				count(row.requests),
				percent(share(row.cacheRead, row.prompt)),
				percent(share(row.instructionsRead, row.instructions)),
				percent(share(row.historyRead, row.history)),
				`${percent(share(row.firstRead, row.firstPrompt))} of ${count(row.firstRequests)}`,
			]),
		),
		"",
		"## Request gaps and cache writes per role",
		"",
		"Measured. A gap is the time between two consecutive requests of one session.",
		"",
		table(
			["role", "sessions", "gaps", "over 5 min", "over 1 h", "cache write tokens", "of them 1 h tier"],
			baseline.gaps.map((row) => [
				row.role,
				count(row.sessions),
				count(row.gaps),
				`${count(row.overShort)} (${percent(share(row.overShort, row.gaps))})`,
				`${count(row.overLong)} (${percent(share(row.overLong, row.gaps))})`,
				count(row.cacheWrite),
				percent(share(row.cacheWrite1h, row.cacheWrite)),
			]),
		),
		"",
		"## Tool calls per tool per role",
		"",
		"Measured.",
		"",
		...baseline.tools.map(
			(role) =>
				`- **${role.role}** (${count(role.sessions)} sessions): ${
					[...role.calls]
						.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
						.map(([tool, calls]) => `${tool} ${count(calls)}`)
						.join(", ") || "no calls"
				}`,
		),
	];
	if (githubTools.length > 0) {
		const roles = ["reviewer", "researcher", "general"];
		out.push(
			"",
			"### GitHub tools per role (decides T2)",
			"",
			table(
				["tool", ...roles.map((role) => `${role} (${roleToolCalls(baseline, role, []).sessions} sessions)`)],
				githubTools.map((tool) => [
					tool,
					...roles.map((role) => count(roleToolCalls(baseline, role, [tool]).calls[0][1])),
				]),
			),
		);
	}
	out.push(
		"",
		"## Main sessions by children started (decides E4)",
		"",
		`Measured from each main session's own \`agent\` calls: ${count(children.mainSessions)} main sessions; ${count(children.none)} started none, ${count(children.one)} one, ${count(children.twoOrMore)} two or more (${percent(share(children.twoOrMore, children.mainSessions))}). Cross-check from run rows with a stored parent session: ${count(children.runsOne)} with one child, ${count(children.runsTwoOrMore)} with two or more.`,
		"",
		"## Output tokens spent on `reason` (E5)",
		"",
		`Estimated (${CHARS_PER_TOKEN} characters per token plus ${REASON_KEY_TOKENS} tokens for the key); output tokens are measured.`,
		"",
		table(
			["role", "tool calls", "with reason", "reason characters", "reason tokens", "output tokens", "share"],
			[...reason.byRole, reason.total].map((row) => [
				row.role,
				count(row.calls),
				count(row.withReason),
				count(row.chars),
				count(row.tokens),
				count(row.output),
				percent(share(row.tokens, row.output)),
			]),
		),
		"",
		"## Reports whose first word is not an outcome word (L2)",
		"",
		`Measured from each child session's last answer: ${count(reports.miss)} of ${count(reports.reports)} do not start with an outcome word (${percent(share(reports.miss, reports.reports))}). Run rows: of ${count(reports.runs.completed)} completed child runs the outcome was found in the first word for ${count(reports.runs.first)}, elsewhere for ${count(reports.runs.otherSource)}, and not recorded for ${count(reports.runs.unrecorded)}.`,
		"",
		table(
			["model", "reports", "not an outcome word first"],
			reports.byModel.map((row) => [row.model, count(row.reports), count(row.miss)]),
		),
		"",
		"## Skill loads",
		"",
		`Measured: ${count(skills.loads)} \`skill\` calls in ${count(skills.withLoad)} of ${count(skills.sessions)} sessions.`,
		"",
		"## First prompts replayed against stored memories (decides A3)",
		"",
		`${count(memory.memories)} stored memories, ${count(memory.prompts)} first prompts of main sessions. Measured: ${count(memory.hit)} prompts have a memory that clears the relevance floor. Estimated (trigram proxy, no stored relevance label): ${count(memory.nearOnly)} have none that clears it and one whose title or keywords nearly match. ${count(memory.none)} match nothing.`,
		"",
		"## Not stored",
		"",
		"- Cache read per instruction block: providers report one cache-read count per request, so the per-block share is the estimate above.",
		"- Summarizer overflow drops: no entry or event records a dropped compaction input.",
		"- Which memory a prompt needed: no relevance label is stored, so recall is a proxy.",
		"",
	);
	return out.join("\n");
}
