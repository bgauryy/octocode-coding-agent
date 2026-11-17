import { contentText, getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { parseSkillBlock } from "./prompt-expansion.ts";
import type { ContextUsage } from "../features/index.ts";
import type { AgentSessionModelApi, AgentSessionStateApi } from "./api-state.ts";
import { estimateTokens, estimateProjectedContextTokens } from "../compaction/tokens.ts";
import { contextSizeWarnings, mcpInstructionSizes } from "../context-budget.ts";
import { MCPS_SECTION } from "@octocodeai/octocode-common/mcp-names";
import { sectionFamilyText } from "../system-prompt-spec.ts";
import { archivedSummary } from "../compaction/checkpoint.ts";
import { renderContextLifecycle, type ContextLifecycle } from "./context-lifecycle.ts";

interface ContextContributor {
	name: string;
	tokens: number;
}
export interface ContextReport {
	model: string;
	at: string;
	capacity: number | null;
	catalogCapacity: number | null;
	/** Latest applicable runtime observation, separate from the catalog and the smaller working capacity. */
	observedCapacity?: number;
	currentTokens: number | null;
	reportedTokens: number | null;
	reserve: number;
	threshold: number | null;
	estimatedTotal: number;
	difference: number | null;
	contributors: ContextContributor[];
	/** Parts of the instructions over their share of the window (`context-budget.ts`); nothing is cut for them. */
	warnings: string[];
	note: string;
	/** Committed-projection lifecycle snapshot, before request hooks; absent in older saved reports. */
	compaction?: ContextLifecycle;
}

/** Inspect the committed effective transcript without running hooks or a model request. */
export function contextReport(
	session: Pick<
		AgentSessionStateApi,
		"sessionManager" | "settingsManager" | "model" | "modelRuntime" | "routedModel" | "thinkingLevel" | "systemPrompt"
	> &
		Pick<AgentSessionModelApi, "getContextWindowLimit"> & { getContextUsage(): ContextUsage | undefined },
): ContextReport {
	const projection = session.sessionManager.buildSessionProjection();
	const system = getCurrentSystemMessage(projection.messages);
	const tools = getCurrentTools(projection.messages);
	const settings = session.settingsManager.getCompactionSettings(
		session.routedModel?.model ?? session.model,
		session.routedModel?.thinkingLevel ?? session.thinkingLevel,
	);
	const usage = session.getContextUsage();
	const branch = session.sessionManager.getBranch();
	const measured = estimateProjectedContextTokens(projection, branch);
	const compactions = branch.filter((entry) => entry.type === "compaction");
	const latest = compactions.at(-1);
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
	const effectiveCapacity = session.getContextWindowLimit();
	const observed = projection.messages.findLast(
		(message) =>
			message.role === "assistant" &&
			message.provider === session.model?.provider &&
			message.model === session.model?.id &&
			message.usage.contextWindow === effectiveCapacity &&
			["stop", "toolUse", "length"].includes(message.stopReason),
	);
	return {
		model: session.model ? `${session.model.provider}/${session.model.id}` : "No model selected",
		at: new Date().toISOString(),
		capacity,
		catalogCapacity:
			session.model && effectiveCapacity !== undefined
				? (session.modelRuntime.getModel(session.model.provider, session.model.id)?.contextWindow ?? null)
				: null,
		...(observed && effectiveCapacity !== undefined ? { observedCapacity: effectiveCapacity } : {}),
		currentTokens: usage?.tokens ?? null,
		reportedTokens: measured.lastUsageIndex === null || usage?.tokens === null ? null : measured.usageTokens,
		reserve: settings.reserveTokens,
		threshold: capacity ? Math.max(0, capacity - settings.reserveTokens) : null,
		estimatedTotal,
		difference: usage?.tokens === null || usage?.tokens === undefined ? null : usage.tokens - estimatedTotal,
		contributors,
		warnings: contextSizeWarnings({
			servers: mcpInstructionSizes(sectionFamilyText(system?.sections ?? {}, MCPS_SECTION)),
			contextFilesChars: sectionFamilyText(system?.sections ?? {}, "project_context").length,
			contextWindow: capacity,
		}),
		compaction: {
			enabled: settings.enabled,
			recordedCompactions: compactions.length,
			activeCheckpoints: projection.messages.filter((message) => message.role === "compactionSummary").length,
			otherMessages: projection.messages.filter(
				(message) => message.role !== "system" && message.role !== "compactionSummary",
			).length,
			keepRecentTokens: settings.keepRecentTokens,
			persistent: session.sessionManager.isPersisted(),
			latest: latest
				? {
						at: latest.timestamp,
						tokensBefore: latest.tokensBefore,
						separateCheckpoint: archivedSummary(latest.details) !== undefined,
					}
				: null,
		},
		note: "Current usage is the session estimate anchored to available provider receipts, not exact tokenization. Contributors estimate the committed projection; the next request's hooks and provider transformations can change it. Unknown usage after compaction stays unknown. Skill bodies already present in messages are counted once; skill listings remain in instruction sections.",
	};
}

/** Cells of the usage bar under the total. */
const BAR_CELLS = 30;

const percentOf = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/**
 * The total first: tokens in use out of the working window, the share, what is free and how far compaction is, with a
 * bar. Without a usage figure (none since the last compaction) the contributors' estimate stands in, labelled.
 */
function totalLines(report: ContextReport, number: (value: number | null) => string): string {
	const used = report.currentTokens ?? report.estimatedTotal;
	const source = report.currentTokens === null ? " (estimated from the contents below)" : "";
	if (!report.capacity)
		return `**Total context: ${number(used)} tokens in use**${source}; the model's window is unknown.`;
	const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((used / report.capacity) * BAR_CELLS)));
	const lines = [
		`**Total context: ${number(used)} of ${number(report.capacity)} tokens in use (${percentOf(used, report.capacity)})**${source}`,
		`\`${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}\` ${number(Math.max(0, report.capacity - used))} free`,
	];
	if (report.compaction?.enabled === false) lines.push("Automatic compaction is off. /compact runs it manually.");
	else if (report.threshold !== null)
		lines.push(
			used > report.threshold
				? `Above the compaction threshold (${number(report.threshold)} tokens): the next request may compact eligible history first.`
				: `Automatic compaction is eligible above ${number(report.threshold)} tokens, ${number(report.threshold - used)} from now.`,
		);
	return lines.join("\n");
}

export function renderContextReport(report: ContextReport, all = false): string {
	const number = (value: number | null) => (value === null ? "unknown" : value.toLocaleString());
	const rows = [...report.contributors].sort((a, b) => b.tokens - a.tokens);
	const visible = all ? rows : rows.slice(0, 8);
	const share = (tokens: number) => (report.estimatedTotal > 0 ? percentOf(tokens, report.estimatedTotal) : "");
	const rest = rows.slice(visible.length).reduce((sum, row) => sum + row.tokens, 0);
	return [
		totalLines(report, number),
		report.warnings.map((warning) => `Warning: ${warning}`).join("\n"),
		report.compaction ? renderContextLifecycle(report.compaction, report.threshold) : "",
		[
			"| What uses it | Estimated tokens | Share |\n| --- | ---: | ---: |",
			...visible.map((row) => `| ${row.name.replaceAll("|", "\\|")} | ${number(row.tokens)} | ${share(row.tokens)} |`),
			rows.length > visible.length ? `| Other contributors | ${number(rest)} | ${share(rest)} |` : "",
			`| **Total** | **${number(report.estimatedTotal)}** | ${report.estimatedTotal > 0 ? "100%" : ""} |`,
		]
			.filter(Boolean)
			.join("\n"),
		`Model: ${report.model}\nSnapshot: ${report.at}`,
		`Latest valid provider receipt: ${number(report.reportedTokens)} tokens\nCurrent estimate: ${number(report.currentTokens)} / ${number(report.capacity)} tokens\nOutput reserve: ${number(report.reserve)}\nCompaction threshold: ${number(report.threshold)}`,
		report.catalogCapacity === null
			? "Select a physical model with /model before choosing a context budget."
			: `Catalog capacity: ${number(report.catalogCapacity)} tokens. /context size chooses a smaller working budget for this session; /context reset restores full capacity.`,
		`Contents total: ${number(report.estimatedTotal)}. Difference from current estimate: ${number(report.difference)} (signed, unattributed).`,
		report.note,
		report.currentTokens !== null && report.threshold !== null && report.currentTokens >= report.threshold
			? "Consider /compact to free context."
			: `${rows.length > visible.length ? "Use /context all for every contributor. " : ""}/mcp exposure controls tool declaration size.`,
	]
		.filter(Boolean)
		.join("\n\n");
}
