/** Message and entry rendering, and command registration. */

import type { AutocompleteItem, Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { CustomMessage } from "../../messages.ts";
import type { CustomEntry } from "../../session-manager.ts";
import type { SourceInfo } from "../../source-info.ts";
import type { ExtensionCommandContext } from "./context.ts";

// ============================================================================
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

export interface EntryRenderOptions {
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

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	aliases?: readonly string[];
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
	invocationAliases?: readonly string[];
}
