import { contentText, getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { parseSkillBlock } from "./prompt-expansion.ts";
import type { AgentSession } from "../agent-session.ts";
import { charsToTokens, estimateTokens, estimateProjectedContextTokens } from "../compaction/tokens.ts";

export interface ContextContributor {
	name: string;
	tokens: number;
}
export interface ContextReport {
	model: string;
	at: string;
	capacity: number | null;
	catalogCapacity: number | null;
	currentTokens: number | null;
	reportedTokens: number | null;
	reserve: number;
	threshold: number | null;
	estimatedTotal: number;
	difference: number | null;
	contributors: ContextContributor[];
	note: string;
}

/** Inspect the committed effective transcript without running hooks or a model request. */
export function contextReport(session: AgentSession): ContextReport {
	const projection = session.sessionManager.buildSessionProjection();
	const system = getCurrentSystemMessage(projection.messages);
	const tools = getCurrentTools(projection.messages);
	const settings = session.settingsManager.getCompactionSettings(session.routedModel?.model ?? session.model);
	const usage = session.getContextUsage();
	const measured = estimateProjectedContextTokens(projection, session.sessionManager.getBranch());
	const contributors: ContextContributor[] = [];
	const add = (name: string, tokens: number) => {
		if (tokens > 0) contributors.push({ name, tokens });
	};
	add("System instructions", charsToTokens(system ? contentText(system.content).length : session.systemPrompt.length));
	for (const [name, text] of Object.entries(system?.sections ?? {}))
		if (text) add(`Instruction section: ${name}`, charsToTokens(text.length));
	for (const tool of tools) add(`Tool definition: ${tool.name}`, charsToTokens(JSON.stringify(tool).length));
	const groups = new Map<string, number>();
	for (const message of projection.messages) {
		if (message.role === "system") continue;
		const skill = message.role === "user" ? parseSkillBlock(contentText(message.content)) : null;
		const tokens = estimateTokens(message);
		const skillTokens = skill ? Math.min(tokens, charsToTokens(skill.content.length)) : 0;
		if (skillTokens)
			groups.set("Loaded skill instructions", (groups.get("Loaded skill instructions") ?? 0) + skillTokens);
		const name = message.role === "toolResult" ? `Tool results: ${message.toolName}` : `${message.role} messages`;
		groups.set(name, (groups.get(name) ?? 0) + tokens - skillTokens);
	}
	for (const [name, tokens] of groups) add(name, tokens);
	const estimatedTotal = contributors.reduce((sum, item) => sum + item.tokens, 0);
	const capacity = usage?.contextWindow ?? session.model?.contextWindow ?? null;
	return {
		model: session.model ? `${session.model.provider}/${session.model.id}` : "No model selected",
		at: new Date().toISOString(),
		capacity,
		catalogCapacity: session.getContextWindowLimit() ?? null,
		currentTokens: usage?.tokens ?? null,
		reportedTokens: measured.lastUsageIndex === null || usage?.tokens === null ? null : measured.usageTokens,
		reserve: settings.reserveTokens,
		threshold: capacity ? Math.max(0, capacity - settings.reserveTokens) : null,
		estimatedTotal,
		difference: usage?.tokens === null || usage?.tokens === undefined ? null : usage.tokens - estimatedTotal,
		contributors,
		note: "Current usage is the session estimate anchored to available provider receipts, not exact tokenization. Contributors estimate the committed projection; the next request's hooks, deferred tool loading and provider transformations can change it. Unknown usage after compaction stays unknown. Skill bodies already present in messages are counted once; skill listings remain in instruction sections.",
	};
}

export function renderContextReport(report: ContextReport, all = false): string {
	const number = (value: number | null) => (value === null ? "unknown" : value.toLocaleString());
	const rows = [...report.contributors].sort((a, b) => b.tokens - a.tokens);
	const visible = all ? rows : rows.slice(0, 8);
	return [
		`Model: ${report.model}\nSnapshot: ${report.at}`,
		`Latest valid provider receipt: ${number(report.reportedTokens)} tokens\nCurrent estimate: ${number(report.currentTokens)} / ${number(report.capacity)} tokens\nOutput reserve: ${number(report.reserve)}\nCompaction threshold: ${number(report.threshold)}`,
		report.catalogCapacity === null
			? "Select a physical model with /model before choosing a context budget."
			: `Catalog capacity: ${number(report.catalogCapacity)} tokens. /context size chooses a smaller working budget for this session; /context reset restores full capacity.`,
		[
			"| Contributor | Estimated tokens |\n| --- | ---: |",
			...visible.map((row) => `| ${row.name.replaceAll("|", "\\|")} | ${number(row.tokens)} |`),
			rows.length > visible.length
				? `| Other contributors | ${number(rows.slice(visible.length).reduce((sum, row) => sum + row.tokens, 0))} |`
				: "",
		]
			.filter(Boolean)
			.join("\n"),
		`\nProjection estimate: ${number(report.estimatedTotal)}. Difference from current estimate: ${number(report.difference)} (signed, unattributed).`,
		report.note,
		report.currentTokens !== null && report.threshold !== null && report.currentTokens >= report.threshold
			? "Consider /compact to free context."
			: "Use /context all for every contributor. /mcp exposure controls tool declaration size.",
	]
		.filter(Boolean)
		.join("\n\n");
}
