/**
 * The baseline over stored sessions that the data-gated steps of the instructions RFC wait for. Pure: it takes rows
 * already read from the agent database and returns numbers; `session-baseline.mjs` reads the rows and prints the report.
 * Every number is `measured` (counted from stored rows) or `estimated` (derived with a stated assumption); the report
 * says which.
 */

import { clearsFloor, MAX_QUERY_TERMS, stem, terms } from "../../../packages/coding-agent/src/octocode/memory/query.ts";

/** Providers of scripted models: their sessions are tests, not use. */
const SCRIPTED_PROVIDERS = new Set(["faux"]);
/** Session directories of tests and disposable runs. */
const TEMP_DIR = /^(?:\/private)?(?:\/var\/folders\/|\/tmp\/)/;
/** A request this long after the previous one finds a 5-minute cache entry expired; this long, a 1-hour one. */
const SHORT_TIER_MS = 5 * 60_000;
const LONG_TIER_MS = 60 * 60_000;
/** Characters per token, and the tokens the `"reason":""` key and quotes cost: both estimates. */
export const CHARS_PER_TOKEN = 4;
export const REASON_KEY_TOKENS = 4;
/** Shorter prompt words match too much by chance to pull a memory in (`memory/inject.ts`). */
const MIN_TERM_LENGTH = 3;
/** The words a report starts with (`native/prompts/report.ts`), and the one label that may come before (`report-outcome.ts`). */
const OUTCOME_WORDS = new Set(["done", "partial", "blocked", "failed"]);
const OUTCOME_LABEL = /^[^\p{L}\p{N}]*(?:report|status|outcome)[^\p{L}\p{N}:]*:[^\p{L}\p{N}]*/iu;

/** Whether a report's first word is an outcome word, light markup and one label aside. */
export function startsWithOutcome(text) {
	const token = text.trim().replace(OUTCOME_LABEL, "").split(/\s/, 1)[0] ?? "";
	return OUTCOME_WORDS.has(token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase());
}

/** Shorter words share too many trigrams by chance (`test`, `latest`) to match approximately. */
const NEAR_MIN_LENGTH = 5;
/**
 * Dice similarity of two words' trigrams at which they count as the same word written differently (`permision` and
 * `permission` score 0.86, `typecheck` and `typechecking` 0.78; `format` and `information` 0.42, `search` and
 * `research` 0.63). An uncalibrated starting value: no labelled recall data exists yet.
 */
const NEAR_THRESHOLD = 0.65;

/** The trigrams of `word`, padded so its start and end count (`cat` → `  c`, ` ca`, `cat`, `at `). */
function trigrams(word) {
	const padded = `  ${word} `;
	const out = new Set();
	for (let index = 0; index + 3 <= padded.length; index++) out.add(padded.slice(index, index + 3));
	return out;
}

/** Dice similarity of the trigram sets of two words: 1 for the same word, 0 for none shared. */
export function trigramSimilarity(a, b) {
	const left = trigrams(a);
	const right = trigrams(b);
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared++;
	return (2 * shared) / (left.size + right.size);
}

/**
 * How closely the prompt `words` match a memory's title and keywords when no word matches exactly: the sum, over the
 * prompt words of `NEAR_MIN_LENGTH`+ letters, of the best trigram similarity to a title or keyword word, counting only
 * those at or above `NEAR_THRESHOLD`. 0 when none is that close. The body is not read: a long body nears many words
 * by chance.
 */
export function nearScore(memory, words) {
	const head = terms(`${memory.title} ${memory.keywords}`).filter((word) => word.length >= NEAR_MIN_LENGTH);
	let score = 0;
	for (const word of words) {
		if (word.length < NEAR_MIN_LENGTH) continue;
		const best = Math.max(0, ...head.map((candidate) => trigramSimilarity(word, candidate)));
		if (best >= NEAR_THRESHOLD) score += best;
	}
	return score;
}

const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
export const share = (part, whole) => (whole > 0 ? part / whole : undefined);

/** The role of a run: `main`, the child's profile, or `general` for a child started without one. */
const runRole = (run) => (run.kind === "main" ? "main" : (run.profile ?? "general"));

/** `Your name is `x` (implementer).` in a child's identity entry: the role of a child whose run row is gone. */
const IDENTITY_ROLE = /Your name is `[^`]+` \(([\w:-]+)\)/;

/** Whether an `agent` call starts children, and how many (a `resume` continues one that exists). */
function childrenStarted(args) {
	if (args?.type !== "task" || args.resume !== undefined) return 0;
	return Array.isArray(args.tasks) ? args.tasks.length : args.task === undefined ? 0 : 1;
}

function textOf(content) {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.flatMap((part) => (part?.type === "text" ? [part.text] : [])).join("\n") : "";
}

/**
 * Folds the stored rows into per-session facts, then into the baseline. `entries` yields `{ sessionId, data }` in each
 * session's file order (`data` is the entry's JSON text), `headers` is `{ sessionId, header }`, `runs` are `AgentRun`s
 * and `memories` are `{ title, keywords, body }`.
 */
export function sessionBaseline({ entries, headers, runs, memories = [] }) {
	const roleBySession = new Map(runs.filter((run) => run.sessionId).map((run) => [run.sessionId, runRole(run)]));
	const sessions = new Map();
	for (const { sessionId, header } of headers) {
		const parsed = parse(header) ?? {};
		sessions.set(sessionId, {
			id: sessionId,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			child: typeof parsed.parentSession === "string",
			role: roleBySession.get(sessionId),
			requests: [],
			tools: new Map(),
			started: 0,
			reason: { calls: 0, withReason: 0, chars: 0 },
			firstPrompt: undefined,
			report: undefined,
			real: false,
		});
	}
	for (const { sessionId, data } of entries) {
		const session = sessions.get(sessionId);
		const entry = parse(data);
		if (!session || !entry) continue;
		if (entry.customType === "octocode-subagent-identity" && !session.role) {
			session.role = IDENTITY_ROLE.exec(entry.data?.text ?? "")?.[1];
			session.child = true;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "user" && session.firstPrompt === undefined) session.firstPrompt = textOf(message.content);
		if (message?.role !== "assistant") continue;
		const scripted = SCRIPTED_PROVIDERS.has(message.provider);
		if (!scripted) session.real = true;
		const usage = message.usage ?? {};
		if (!scripted)
			session.requests.push({
				at: typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp),
				input: usage.input ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				cacheWrite1h: usage.cacheWrite1h ?? 0,
				output: usage.output ?? 0,
			});
		const parts = Array.isArray(message.content) ? message.content : [];
		// A child's report is its last answer that calls no tool.
		if (!scripted && textOf(parts).trim() && !parts.some((part) => part?.type === "toolCall"))
			session.report = { text: textOf(parts), model: message.model ?? "unknown" };
		for (const part of parts) {
			if (part?.type !== "toolCall" || scripted) continue;
			bump(session.tools, part.name);
			session.reason.calls++;
			if (typeof part.arguments?.reason === "string") {
				session.reason.withReason++;
				session.reason.chars += part.arguments.reason.length;
			}
			if (part.name === "agent") session.started += childrenStarted(part.arguments);
		}
	}
	const measured = [...sessions.values()].filter((session) => session.real && !TEMP_DIR.test(session.cwd));
	for (const session of measured) session.role ??= session.child ? "child (role not stored)" : "main";
	return {
		scope: {
			sessions: sessions.size,
			measured: measured.length,
			excluded: sessions.size - measured.length,
			requests: measured.reduce((sum, session) => sum + session.requests.length, 0),
		},
		cache: cacheByDayAndRole(measured),
		gaps: gapsByRole(measured),
		tools: toolsByRole(measured),
		children: childStarts(measured, runs),
		reason: reasonCost(measured),
		reports: reportOutcomes(measured, runs),
		skills: skillLoads(measured),
		memory: memoryReplay(measured, memories),
	};
}

/**
 * Cache read share per day and role. A provider reports one cache-read count per request, and a cache read is always a
 * prefix, so the split is: the instruction prefix (system prompt and tool declarations) is read first, history after
 * it. The prefix size is estimated as the prompt size of the session's first request, which has no history.
 */
function cacheByDayAndRole(sessions) {
	const rows = new Map();
	for (const session of sessions) {
		const first = session.requests[0];
		if (!first) continue;
		const prefix = first.input + first.cacheRead + first.cacheWrite;
		session.requests.forEach((request, index) => {
			const day = Number.isFinite(request.at) ? new Date(request.at).toISOString().slice(0, 10) : "unknown";
			const key = `${day}\t${session.role}`;
			const row = rows.get(key) ?? {
				day,
				role: session.role,
				requests: 0,
				prompt: 0,
				cacheRead: 0,
				instructions: 0,
				instructionsRead: 0,
				history: 0,
				historyRead: 0,
				firstRequests: 0,
				firstPrompt: 0,
				firstRead: 0,
			};
			const prompt = request.input + request.cacheRead + request.cacheWrite;
			const instructions = Math.min(prefix, prompt);
			const instructionsRead = Math.min(request.cacheRead, instructions);
			row.requests++;
			row.prompt += prompt;
			row.cacheRead += request.cacheRead;
			row.instructions += instructions;
			row.instructionsRead += instructionsRead;
			row.history += prompt - instructions;
			row.historyRead += request.cacheRead - instructionsRead;
			if (index === 0) {
				row.firstRequests++;
				row.firstPrompt += prompt;
				row.firstRead += request.cacheRead;
			}
			rows.set(key, row);
		});
	}
	return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.role.localeCompare(b.role));
}

/** Per role: how often the next request came after a cache tier had expired, and what was written to each tier. */
function gapsByRole(sessions) {
	const rows = new Map();
	for (const session of sessions) {
		const row = rows.get(session.role) ?? {
			role: session.role,
			sessions: 0,
			gaps: 0,
			overShort: 0,
			overLong: 0,
			cacheWrite: 0,
			cacheWrite1h: 0,
		};
		row.sessions++;
		session.requests.forEach((request, index) => {
			row.cacheWrite += request.cacheWrite;
			row.cacheWrite1h += request.cacheWrite1h;
			const gap = index > 0 ? request.at - session.requests[index - 1].at : Number.NaN;
			if (!Number.isFinite(gap)) return;
			row.gaps++;
			if (gap > SHORT_TIER_MS) row.overShort++;
			if (gap > LONG_TIER_MS) row.overLong++;
		});
		rows.set(session.role, row);
	}
	return [...rows.values()].sort((a, b) => a.role.localeCompare(b.role));
}

/** Tool calls per tool name per role, with the sessions of each role: zero calls only means something beside that count. */
function toolsByRole(sessions) {
	const roles = new Map();
	for (const session of sessions) {
		const role = roles.get(session.role) ?? { role: session.role, sessions: 0, calls: new Map() };
		role.sessions++;
		for (const [tool, count] of session.tools) bump(role.calls, tool, count);
		roles.set(session.role, role);
	}
	return [...roles.values()].sort((a, b) => a.role.localeCompare(b.role));
}

/** The calls of `role` to each of `tools`, zero included: what decides whether a role keeps a tool. */
export function roleToolCalls(baseline, role, tools) {
	const found = baseline.tools.find((entry) => entry.role === role);
	return { sessions: found?.sessions ?? 0, calls: tools.map((tool) => [tool, found?.calls.get(tool) ?? 0]) };
}

/** Main sessions by the children they started, from their own `agent` calls and, as a cross-check, from the run rows. */
function childStarts(sessions, runs) {
	const mains = sessions.filter((session) => session.role === "main");
	const byParent = new Map();
	for (const run of runs) if (run.kind === "child" && run.parentSessionId) bump(byParent, run.parentSessionId);
	const ids = new Set(mains.map((session) => session.id));
	const fromRuns = [...byParent].filter(([id]) => ids.has(id)).map(([, count]) => count);
	return {
		mainSessions: mains.length,
		none: mains.filter((session) => session.started === 0).length,
		one: mains.filter((session) => session.started === 1).length,
		twoOrMore: mains.filter((session) => session.started >= 2).length,
		runsOne: fromRuns.filter((count) => count === 1).length,
		runsTwoOrMore: fromRuns.filter((count) => count >= 2).length,
	};
}

/** Output tokens spent on the `reason` argument: its characters over `CHARS_PER_TOKEN` plus the key, an estimate. */
function reasonCost(sessions) {
	const rows = new Map();
	for (const session of sessions) {
		const row = rows.get(session.role) ?? { role: session.role, calls: 0, withReason: 0, chars: 0, output: 0 };
		row.calls += session.reason.calls;
		row.withReason += session.reason.withReason;
		row.chars += session.reason.chars;
		row.output += session.requests.reduce((sum, request) => sum + request.output, 0);
		rows.set(session.role, row);
	}
	const withTokens = (row) => ({
		...row,
		tokens: Math.round(row.chars / CHARS_PER_TOKEN) + row.withReason * REASON_KEY_TOKENS,
	});
	const byRole = [...rows.values()].map(withTokens).sort((a, b) => a.role.localeCompare(b.role));
	const total = withTokens(
		byRole.reduce(
			(sum, row) => ({
				role: "all",
				calls: sum.calls + row.calls,
				withReason: sum.withReason + row.withReason,
				chars: sum.chars + row.chars,
				output: sum.output + row.output,
			}),
			{ role: "all", calls: 0, withReason: 0, chars: 0, output: 0 },
		),
	);
	return { total, byRole };
}

/**
 * Reports whose first word is not an outcome word, two ways. From transcripts: each child session's last answer that
 * calls no tool, by the model that wrote it. From run rows: completed child runs by where the harness found the outcome
 * (`first` is the first word); a completed run with no outcome recorded says nothing about its report's wording.
 */
function reportOutcomes(sessions, runs) {
	const byModel = new Map();
	for (const session of sessions) {
		if (session.role === "main" || !session.report) continue;
		const row = byModel.get(session.report.model) ?? { model: session.report.model, reports: 0, miss: 0 };
		row.reports++;
		if (!startsWithOutcome(session.report.text)) row.miss++;
		byModel.set(row.model, row);
	}
	const rows = [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
	const completed = runs.filter((run) => run.kind === "child" && run.endReason === "completed");
	return {
		reports: rows.reduce((sum, row) => sum + row.reports, 0),
		miss: rows.reduce((sum, row) => sum + row.miss, 0),
		byModel: rows,
		runs: {
			completed: completed.length,
			first: completed.filter((run) => run.outcomeSource === "first").length,
			otherSource: completed.filter((run) => run.outcomeSource && run.outcomeSource !== "first").length,
			unrecorded: completed.filter((run) => !run.outcomeSource).length,
		},
	};
}

function skillLoads(sessions) {
	const loads = sessions.map((session) => session.tools.get("skill") ?? 0);
	return {
		sessions: sessions.length,
		withLoad: loads.filter((count) => count > 0).length,
		loads: loads.reduce((sum, count) => sum + count, 0),
	};
}

/**
 * Replays each main session's first prompt against the stored memories, ignoring scope. `hit`: a memory clears the
 * relevance floor (an exact word in its title or keywords, or two in its body). `nearOnly`: none does, and one has a
 * title or keyword word within trigram distance of a prompt word, the proxy for "a relevant memory and no hit" (no
 * stored label says which memory a prompt needed).
 */
function memoryReplay(sessions, memories) {
	const prompts = sessions.filter((session) => session.role === "main" && session.firstPrompt?.trim());
	let hit = 0;
	let nearOnly = 0;
	for (const session of prompts) {
		const words = terms(session.firstPrompt, MAX_QUERY_TERMS).filter((word) => word.length >= MIN_TERM_LENGTH);
		const stems = new Set(words.map(stem));
		if (memories.some((memory) => clearsFloor(memory, stems))) hit++;
		else if (memories.some((memory) => nearScore(memory, words) > 0)) nearOnly++;
	}
	return { memories: memories.length, prompts: prompts.length, hit, nearOnly, none: prompts.length - hit - nearOnly };
}
