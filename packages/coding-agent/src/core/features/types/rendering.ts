/** Message and entry rendering, and command registration. */

import type { AutocompleteItem, Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../theme/theme.ts";
import type { CustomMessage } from "../../messages.ts";
import type { CustomEntry } from "../../session-manager.ts";
import type { SourceInfo } from "../../source-info.ts";
import type { CommandContext } from "./context.ts";

// Message and Entry Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
	/** Horizontal padding configured by the outputPad setting. */
	outputPad: number;
}

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

interface EntryRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	/** Usage shown beside the command in autocomplete and `get_commands`, such as `[all|<query>]`. */
	argumentHint?: string;
	/**
	 * The only first words the command accepts, lowercase. The terminal keeps other text in the editor instead of running
	 * the command, so a message that starts with the command's name (`/harness shows only skills`) is not lost.
	 */
	argumentWords?: readonly string[];
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: CommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}
