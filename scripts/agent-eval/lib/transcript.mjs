/**
 * Transcript metrics. A transcript is the session JSONL the agent writes: `type:"message"` entries with
 * `message.role`, assistant `content[]` items of `type:"toolCall"` and `usage.{input,cacheRead,cacheWrite,output,cost}`,
 * plus side-request usage on `type:"usage"`, `compaction` and `branch_summary` entries.
 */

/** A plain code read run through bash; the same rule as `.octocode/efficiency/2026-11-04/usage*.py`. */
const BASH_READ = /^\s*(cd \S+ *(&&|;) *)?(set -o pipefail; *)?(rg|grep|find|fd|ls|cat|head|tail|sed|wc)\b/;

const CHILD_ROLE = /Your name is `([^`]+)`(?: \(([a-z][\w-]*)\))?/;
/** Text in a tool call's arguments that means the solver went looking for this kit. */
const LEAK = /agent-eval/;
const SIDE_ENTRIES = new Set(["usage", "compaction", "branch_summary"]);

const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((item) => item?.type === "text" && typeof item.text === "string")
					.map((item) => item.text)
					.join("\n")
			: "";

export function classifyCall(name, args) {
	if (typeof name === "string" && name.startsWith("mcp__octocode__")) return "octocode";
	if (name === "bash") return BASH_READ.test(args?.command ?? "") ? "bashRead" : "bashOther";
	if (name === "file") return "file";
	if (name === "agent" || name === "task") return "delegate";
	if (name === "skill") return "skill";
	return "other";
}

const emptyTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const emptyTools = () => ({ octocode: 0, bashRead: 0, bashOther: 0, file: 0, delegate: 0, skill: 0, other: 0 });

function addUsage(summary, usage) {
	for (const key of Object.keys(summary.tokens)) summary.tokens[key] += usage[key] ?? 0;
	const cost = usage.cost?.total;
	if (typeof cost === "number") summary.cost += cost;
	else summary.missingCost++;
}

/** Everything one transcript's text says about its run. Malformed lines are counted, never fatal (a torn last write). */
export function summarizeTranscript(text) {
	const summary = {
		requests: 0,
		sideRequests: 0,
		turns: 0,
		multiCallTurns: 0,
		toolCalls: 0,
		cost: 0,
		missingCost: 0,
		malformedLines: 0,
		tokens: emptyTokens(),
		tools: emptyTools(),
		byTool: {},
		models: {},
		skillLoads: [],
		leakCalls: 0,
		finalText: "",
		lastStopReason: undefined,
		errorMessage: undefined,
		childName: undefined,
		role: undefined,
	};
	let sawUser = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			summary.malformedLines++;
			continue;
		}
		if (SIDE_ENTRIES.has(entry?.type) && entry.usage) {
			summary.sideRequests++;
			addUsage(summary, entry.usage);
			continue;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || !message || typeof message !== "object") continue;
		if (message.role === "user" && !sawUser) {
			sawUser = true;
			const identity = CHILD_ROLE.exec(textOf(message.content));
			if (identity) {
				summary.childName = identity[1];
				summary.role = identity[2] ?? "general";
			}
		}
		if (message.role !== "assistant") continue;
		if (message.usage) {
			summary.requests++;
			addUsage(summary, message.usage);
			if (message.model) summary.models[message.model] = (summary.models[message.model] ?? 0) + 1;
		}
		summary.lastStopReason = message.stopReason ?? summary.lastStopReason;
		if (message.errorMessage) summary.errorMessage = message.errorMessage;
		const content = Array.isArray(message.content) ? message.content : [];
		const answer = textOf(content);
		if (answer.trim()) summary.finalText = answer;
		const calls = content.filter((item) => item?.type === "toolCall");
		if (calls.length === 0) continue;
		summary.turns++;
		if (calls.length > 1) summary.multiCallTurns++;
		for (const call of calls) {
			const args = call.arguments ?? {};
			summary.toolCalls++;
			summary.tools[classifyCall(call.name, args)]++;
			summary.byTool[call.name] = (summary.byTool[call.name] ?? 0) + 1;
			if (call.name === "skill" && typeof args.name === "string") summary.skillLoads.push(args.name);
			if (LEAK.test(JSON.stringify(args))) summary.leakCalls++;
		}
	}
	return summary;
}

/** The sum of several summaries (main plus children). `finalText` and identity stay with the single transcripts. */
export function combineSummaries(summaries) {
	const total = {
		requests: 0,
		sideRequests: 0,
		turns: 0,
		multiCallTurns: 0,
		toolCalls: 0,
		cost: 0,
		missingCost: 0,
		malformedLines: 0,
		tokens: emptyTokens(),
		tools: emptyTools(),
		byTool: {},
		models: {},
		skillLoads: [],
		leakCalls: 0,
	};
	for (const summary of summaries) {
		for (const key of [
			"requests",
			"sideRequests",
			"turns",
			"multiCallTurns",
			"toolCalls",
			"cost",
			"missingCost",
			"malformedLines",
			"leakCalls",
		]) {
			total[key] += summary[key];
		}
		for (const key of Object.keys(total.tokens)) total.tokens[key] += summary.tokens[key];
		for (const key of Object.keys(total.tools)) total.tools[key] += summary.tools[key];
		for (const [key, value] of Object.entries(summary.byTool)) total.byTool[key] = (total.byTool[key] ?? 0) + value;
		for (const [key, value] of Object.entries(summary.models)) total.models[key] = (total.models[key] ?? 0) + value;
		total.skillLoads.push(...summary.skillLoads);
	}
	return total;
}

const ratio = (part, whole) => (whole > 0 ? part / whole : null);

/** Octocode calls over Octocode calls plus plain bash code reads; null when the run read no code either way. */
export const octocodeShare = (summary) =>
	ratio(summary.tools.octocode, summary.tools.octocode + summary.tools.bashRead);
export const multiCallTurnShare = (summary) => ratio(summary.multiCallTurns, summary.turns);
export const cacheHitRate = (summary) =>
	ratio(summary.tokens.cacheRead, summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite);
