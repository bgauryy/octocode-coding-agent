/**
 * Types shared by InteractiveMode and its collaborator modules.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, Usage } from "@octocodeai/octocode-ai/compat";
import type { EditorComponent, Terminal } from "@octocodeai/octocode-tui";
import type { AgentSessionRuntimeDiagnostic } from "../../../core/agent-session-services.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import type { TuiMode } from "../../../core/settings-manager.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import type { AuthSelectorProvider } from "../components/oauth-selector.ts";
import type { StatusIndicator } from "../components/status-indicator.ts";

/** A link in a status line: the status helper validates `url` (http or https) and draws it as an OSC 8 hyperlink. */
export interface StatusLink {
	url: string;
	/** Shown instead of the URL; defaults to the URL. */
	label?: string;
}

/** Status text: plain strings are shown without terminal controls; links are validated by the helper. */
export type StatusText = string | readonly (string | StatusLink)[];

/** Interface for components that can be expanded/collapsed */
export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export interface ActiveEditor extends EditorComponent {
	getCursor?(): { line: number; col: number };
}

export interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

export type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

export type RenderSessionItem =
	| AgentMessage
	| Extract<SessionEntry, { type: "custom" | "usage" }>
	| CompactionCostNotice;

/** A loaded resource path and the source it was loaded from. */
export interface SourcedPath {
	path: string;
	sourceInfo?: SourceInfo;
}

/** The group a loaded resource is listed under in the startup resource listing. */
export type ScopeGroupName = "user" | "project" | "path";

/** Loaded resources of one scope; package resources are grouped by package source. */
export interface ScopeGroup {
	scope: ScopeGroupName;
	paths: SourcedPath[];
	packages: Map<string, SourcedPath[]>;
}

/** How a scope group renders its plain paths and its package paths. */
export interface ScopeGroupFormatOptions {
	formatPath: (item: SourcedPath) => string;
	formatPackagePath: (item: SourcedPath, source: string) => string;
}

export type LoginProviderCompletionOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
	subscription?: boolean;
};

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .octocode directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode. */
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	terminal?: Terminal;
}
