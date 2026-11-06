import type { AgentContext } from "./capture.ts";
import { systemText } from "./render.ts";

/**
 * A free, offline lint over the exact final prompt each agent receives (B149). It reports defects a reader of the
 * rendered prompt would hit and the source Markdown cannot show: a template marker that was never rendered, a tool the
 * prompt names that this agent cannot call, and a long sentence stated twice.
 */
export interface LintFinding {
	agent: string;
	rule: "unrendered-marker" | "foreign-tool" | "duplicate-sentence";
	detail: string;
}

/**
 * Backticked tool names an agent's system prompt may mention without declaring the tool. Each entry is
 * `<agent>:<tool>` (or `*:<tool>`) with the reason it is legitimate; add none without one.
 */
export const FOREIGN_TOOL_ALLOWLIST: Record<string, string> = {};

const MIN_SENTENCE = 60;

/** Sentences of 60+ characters, whitespace-normalised, outside fenced code blocks. */
function longSentences(text: string): string[] {
	const prose = text.replace(/```[\s\S]*?```/g, " ");
	return prose
		.split(/(?<=[.!?:])\s+|\n+/)
		.map((sentence) =>
			sentence
				.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter((sentence) => sentence.length >= MIN_SENTENCE);
}

/**
 * `all` is every captured agent (the union of their tool names is "declared by some agent"); `context` is the one
 * under test, whose tool-list text (the description of each tool it has) is excluded from the foreign-tool rule.
 */
export function lintPrompt(context: AgentContext, all: readonly AgentContext[]): LintFinding[] {
	const findings: LintFinding[] = [];
	const text = systemText(context);
	const push = (rule: LintFinding["rule"], detail: string) => findings.push({ agent: context.name, rule, detail });

	if (/\{\{|\}\}/.test(text)) push("unrendered-marker", "`{{` or `}}` remains in the rendered prompt");

	const own = new Set(context.tools.map((tool) => tool.name));
	const everyone = new Set(all.flatMap((agent) => agent.tools.map((tool) => tool.name)));
	const mentioned = new Set([...text.matchAll(/`([A-Za-z0-9_]+)`/g)].map((match) => match[1]));
	for (const name of mentioned) {
		if (!everyone.has(name) || own.has(name)) continue;
		if (FOREIGN_TOOL_ALLOWLIST[`${context.name}:${name}`] || FOREIGN_TOOL_ALLOWLIST[`*:${name}`]) continue;
		push("foreign-tool", `\`${name}\` is declared by another agent, not by ${context.name}`);
	}

	const seen = new Set<string>();
	const reported = new Set<string>();
	for (const sentence of longSentences(text)) {
		if (seen.has(sentence) && !reported.has(sentence)) {
			reported.add(sentence);
			push("duplicate-sentence", sentence);
		}
		seen.add(sentence);
	}
	return findings;
}

export const formatFindings = (findings: readonly LintFinding[]): string =>
	findings.map((finding) => `${finding.agent} [${finding.rule}] ${finding.detail}`).join("\n");
