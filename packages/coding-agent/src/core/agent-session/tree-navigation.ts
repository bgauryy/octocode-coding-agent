/** Navigation to another node of the session tree, with the optional summary of the abandoned branch. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { contentText } from "@octocodeai/octocode-ai";
import type { Model, RetryCallbacks, Usage } from "@octocodeai/octocode-ai/compat";
import { collectEntriesForBranchSummary, generateBranchSummary } from "../compaction/index.ts";
import type { TreePreparation } from "../features/index.ts";
import type { BranchSummaryEntry } from "../session-manager.ts";
import type { SessionInternals } from "./host.ts";
import type { RequestAuth } from "./request-auth.ts";

export interface TreeNavigationHost extends Pick<
	SessionInternals,
	"session" | "refreshContext" | "resolveIdleWaitIfIdle"
> {
	getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<RequestAuth & { thinkingLevel: ThinkingLevel }>;
	summarizationRetryCallbacks(source: { source: "branchSummary" }): RetryCallbacks;
	restoreToolsFromTranscript(): void;
}

export interface NavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface NavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
}

export class SessionTreeNavigation {
	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	private readonly host: TreeNavigationHost;

	constructor(host: TreeNavigationHost) {
		this.host = host;
	}

	/** Whether branch summarization is running. */
	get isSummarizing(): boolean {
		return this._branchSummaryAbortController !== undefined;
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abort(): void {
		this._branchSummaryAbortController?.abort();
	}

	async navigate(targetId: string, options: NavigateTreeOptions): Promise<NavigateTreeResult> {
		const { session } = this.host;
		if (session.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (session.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const sessionManager = session.sessionManager;
		const oldLeafId = sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !session.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (session.extensionRunner.hasHandlers("session_before_tree")) {
				const result = await session.extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				});

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = session.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this.host.getSummarizationRequestAuth(session.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: session.agent.streamFunction,
					retry: session.settingsManager.getRetrySettings(),
					callbacks: this.host.summarizationRetryCallbacks({
						source: "branchSummary",
					}),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles ?? [],
					modifiedFiles: result.modifiedFiles ?? [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this.host.refreshContext();
			this.host.restoreToolsFromTranscript();

			// Emit session_tree event
			await session.extensionRunner.emit({
				type: "session_tree",
				newLeafId: sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this.host.resolveIdleWaitIfIdle();
		}
	}
}
