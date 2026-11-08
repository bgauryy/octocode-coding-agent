import type { ContextReport } from "./context-report.ts";
import type { PlanOptions, PlanState } from "../../octocode/plan/state.ts";
import type { RepositoryDiff } from "../../octocode/files/repository-diff.ts";
/**
 * Public API of `AgentSession`, documented here and implemented by the class. The themed parts live
 * in `api-state.ts` (state, tools, models) and `api-run.ts` (prompting, compaction, retry, bash).
 */

import type { ContextUsage, ExtensionRunner, ReplacedSessionContext } from "../features/index.ts";
import type { SessionNameSource } from "../session-manager.ts";
import type { SessionStats } from "../session-stats.ts";
import type { AgentSessionPromptingApi, AgentSessionRecoveryApi } from "./api-run.ts";
import type { AgentSessionModelApi, AgentSessionStateApi, AgentSessionToolsApi } from "./api-state.ts";
import type { NavigateTreeOptions, NavigateTreeResult } from "./tree-navigation.ts";
import type { AgentSessionEventListener, ExtensionBindings } from "./types.ts";

/** Event subscription, session management, export and the extension system of `AgentSession`. */
export interface AgentSessionApi
	extends
		AgentSessionStateApi,
		AgentSessionToolsApi,
		AgentSessionModelApi,
		AgentSessionPromptingApi,
		AgentSessionRecoveryApi {
	getTurnId(): string | undefined;

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void;

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void;

	bindExtensions(bindings: ExtensionBindings): Promise<void>;

	reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;

	/**
	 * Set a display name for the current session; `source` defaults to `user`, which automatic titles never replace.
	 */
	setSessionName(name: string, source?: SessionNameSource): void;

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }>;

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats;

	getContextUsage(): ContextUsage | undefined;
	getContextReport(): ContextReport;
	askSideQuestion(question: string): Promise<string>;
	getRepositoryDiff(selection?: string, signal?: AbortSignal): Promise<RepositoryDiff>;
	getUntrackedDiff(root: string, file: string): Promise<string>;
	controlPlan(options: PlanOptions): Promise<PlanState>;
	stopActiveWork(): Promise<void>;

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	exportToHtml(outputPath?: string, options?: { themeName?: string }): Promise<string>;

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string;

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string>;

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined;

	createReplacedSessionContext(): ReplacedSessionContext;

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean;

	/** Answer the dialog a run is blocked on (`awaiting.id`) for a client other than this mode's UI. */
	answerDialog(
		id: string,
		answer: { choice?: string; text?: string; replies?: unknown },
	): { ok: true } | { ok: false; reason: string };

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	readonly extensionRunner: ExtensionRunner;
}
