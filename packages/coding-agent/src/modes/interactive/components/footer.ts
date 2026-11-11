import { resolve } from "node:path";
import { type Component, ELLIPSIS, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/features/types.ts";
import type { ReadonlyFooterDataProvider, StatusEntry } from "../../../core/footer-data-provider.ts";
import {
	addUsageToTotals,
	createUsageTotals,
	customMessageUsage,
	type UsageTotals,
} from "../../../core/usage-totals.ts";
import { cachedPercent, formatCost, formatTokens } from "../../../octocode/shared/format.ts";
import { paintStatus } from "../../../theme/status.ts";
import { theme } from "../../../theme/theme.ts";
import { coordinatorFooterLines } from "./footer-coordinator.ts";
import { styledLine } from "../../../../../common/src/sanitize.ts";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolved = resolve(cwd);
	const shown = homeTilde(resolved, resolve(home));
	return shown === resolved ? cwd : shown;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Nothing to invalidate: the footer renders from live session data, and the provider caches the git branch. */
	invalidate(): void {}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "custom_message") {
				const usage = customMessageUsage(entry);
				if (usage) addUsageToTotals(usageTotals, usage);
			}
		}

		// The hit rate describes the branch the next request continues, not the reply written last to the file.
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const { input, cacheRead, cacheWrite } = entry.message.usage;
			// A reply without prompt counts (aborted before usage arrived) keeps the last known rate.
			latestCacheHitRate = cachedPercent(cacheRead, input + cacheRead + cacheWrite, 1) ?? latestCacheHitRate;
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		// Unknown (no usage yet, or just compacted) reads `?`, never `0.0%`.
		const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd}${SEPARATOR}${sessionName}`;
		}

		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		const usingSubscription = state.model ? this.session.modelRuntime.isUsingSubscription(state.model.provider) : false;
		if (usageTotals.cost || usingSubscription) {
			const money = formatCost({ cost: usageTotals.cost, unpriced: false }) || "≈$0.00";
			statsParts.push(usingSubscription ? `${money} (sub)` : money);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 80) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue >= 50) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		// Context fill is the signal users act on: first, so narrow terminals cut the token counters before it.
		statsParts.unshift(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "·")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		const statsLine = truncateToWidth(statsParts.join(" "), width, ELLIPSIS);
		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", ELLIPSIS));
		const lines = [
			pwdLine,
			theme.fg("dim", statsLine),
			...coordinatorFooterLines(this.session, width).map((line) => theme.fg("dim", line)),
		];
		// Statuses are data (text and tone); the live theme paints them. A provider without state gives plain text.
		const data = this.footerData.getState?.();

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses: ReadonlyMap<string, StatusEntry> =
			data?.statuses ??
			new Map([...this.footerData.getExtensionStatuses()].map(([key, text]) => [key, { text }] as const));
		if (extensionStatuses.size > 0) {
			const statuses = Array.from(extensionStatuses.entries()).sort(([a], [b]) => a.localeCompare(b));
			const renderStatuses = () =>
				statuses.map(([, status]) => paintStatus({ ...status, text: styledLine(status.text) }, theme)).join(" ");
			let statusLine = renderStatuses();
			if (visibleWidth(statusLine) > width) {
				// Put actionable failures ahead of routine status when the terminal cuts this line.
				const priority = (tone?: string): number => {
					if (tone === "error") return 0;
					if (tone === "warning") return 1;
					if (tone === "accent") return 2;
					return tone === "muted" || tone === "dim" ? 4 : 3;
				};
				statuses.sort(([a, left], [b, right]) => priority(left.tone) - priority(right.tone) || a.localeCompare(b));
				statusLine = renderStatuses();
			}
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", ELLIPSIS)));
		}

		return lines;
	}
}
