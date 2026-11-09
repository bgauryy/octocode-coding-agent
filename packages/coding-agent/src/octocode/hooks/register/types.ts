import type { FileInputReplacement } from "../../tool-input/claude-file.ts";
import type { ToolInvocation } from "../../../core/features/types.ts";
import type { SourcePermissionUpdate } from "../../shared/permission-updates.ts";
import type { JsonObject } from "@octocodeai/octocode-ai";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../../core/features/index.ts";
import type { MessageEnvelope } from "../../shared/messages.ts";
import type { HookEvent, HookProtocol } from "../catalog.ts";
import type { HookConfig, HookVerdict } from "../contracts.ts";

export const CONTEXT_TYPE = "octocode-hook-context";
/** Longest the first prompt waits for SessionStart hooks still running. */
export const START_HOOKS_WAIT_MS = 15_000;
export const STOP_TYPE = "octocode-hook-stop";
export const STOP_PREFIX = "Stop hook feedback:\n";
/** Claude Code's cap on consecutive Stop-hook continuations; a tool call resets the count. */
export const STOP_CONTINUE_CAP = 8;
/** A hook run this slow is reported once: PreToolUse hooks hold back every call of the batch. */
export const SLOW_HOOK_MS = 5_000;

/** Time each hook command took, for `/hooks`. */
export interface HookTiming {
	runs: number;
	totalMs: number;
	maxMs: number;
	/** Runs that gave no answer: timed out, crashed, could not run, or an MCP tool that errored or was missing. */
	failed: number;
}

/** What a Notification hook receives besides the common fields (Claude Code's shape). */
interface HookNotice {
	message: string;
	title?: string;
	/** Claude Code's `notification_type`: `permission_prompt`, `elicitation_dialog` or `idle_prompt`. */
	type: string;
}

/** What `/hooks` and `/status` show about hooks. */
export interface HooksView {
	/** The `hooks` prompt section for the hooks this session runs, or "" when it runs none. */
	promptSection(): string;
	suspend?(): Promise<void>;
	hasFilePermissionRequest(input: Record<string, unknown>, cwd: string): boolean;
	fileInputCommitted(id: string, input: Record<string, unknown>, cwd?: string): void;
	permissionRequest(
		invocation: ToolInvocation,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<
		| {
				decision: "allow" | "deny";
				message?: string;
				interrupt?: boolean;
				updatedInput?: JsonObject;
				updatedFileInputs?: FileInputReplacement[];
				updatedPermissions?: SourcePermissionUpdate[];
		  }
		| undefined
	>;
	/** One line for the `/status` report. */
	summary(): string;
	/** On/off, the loaded commands per event, the files read (✓ = exists) and any config errors. */
	report(cwd: string): string;
	/** The PreToolUse hooks as a tool-call gate (a no-op while hooks are off); `ask` carries a hook's ask to the permission gate. */
	preToolUse(
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<(ToolCallEventResult & { ask?: string; rewritten?: true }) | undefined>;
	/** Runs the Notification hooks matching `notice.type` in the background (a no-op while hooks are off). */
	notification(notice: HookNotice, ctx: ExtensionContext): void;
	messageSend(message: MessageEnvelope, ctx: ExtensionContext): Promise<{ block?: string; ask?: string } | undefined>;
	messageReceive(message: MessageEnvelope, ctx: ExtensionContext): Promise<void>;
}

/** Records a hook outcome in the permission audit: a `PreToolUse` hook that gave no answer (`allowed`: the call went ahead), or an HTTP hook's allow or input rewrite (`allowed: true`, naming its host). */
export type HookFailureSink = (what: readonly string[], note: string, allowed: boolean) => void;

/** What every event handler shares: the loaded config (replaced on each session start) and the repository root. */
export interface HookSession {
	config: HookConfig;
	errors: string[];
	/** Handlers a `/harness` switch (or a harness off by default) left out at the last session start. */
	switchedOff?: number;
	/** The repository root for CLAUDE_PROJECT_DIR, found once per session and only when a hook actually runs. */
	root: string | undefined;
}

export type Dispatch = (
	ctx: ExtensionContext,
	event: HookEvent,
	names: string[],
	input: () => Record<string, unknown>,
	signal?: AbortSignal,
	protocol?: HookProtocol | readonly HookProtocol[],
) => Promise<HookVerdict>;
export interface HookHostMetadata {
	permissionMode?: "manual" | "workspace" | "full" | "bypass";
	agentName?: string;
	agentType?: string;
}

export type ReportFailure = (ctx: ExtensionContext, event: HookEvent, error: unknown) => void;
