import type { JsonObject } from "@octocodeai/octocode-ai";
import type { PluginContext } from "../../core/plugin-context.ts";
import type { HookProtocol } from "./profiles.ts";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"SessionStart",
	"SubagentStart",
	"SubagentStop",
	"Interrupt",
	"SessionEnd",
	"UserPromptSubmit",
	"PreCompact",
	"PostCompact",
	"Stop",
	"StopFailure",
	"Notification",
	"PreMessageSend",
	"PostMessageReceive",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookSource {
	path: string;
	dialect: HookProtocol;
	scope: "user" | "project" | "plugin";
}

export interface HookBase {
	/** Omitted for the existing Octocode contract. Source profiles are explicitly enabled. */
	protocol?: HookProtocol;
	plugin?: PluginContext;
	onFailure?: "continue" | "block";
	timeoutMs: number;
	additionalContextLimit?: number;
	/** The file it came from. */
	source: string;
	/** Configuration provenance, not a claim that this source dialect is implemented. */
	origins?: HookSource[];
	/** Opt-in (`"failClosed": true`): a pre-tool or pre-message failure denies the operation. */
	failClosed?: true;
	/** A required gate with unsupported configuration denies calls without starting a process. */
	configurationError?: string;
}

export interface HookCommand extends HookBase {
	type?: "command";
	command: string;
	args?: string[];
	commandWindows?: string;
	async?: boolean;
	asyncRewake?: boolean;
}
export interface HookHttp extends HookBase {
	type: "http";
	url: string;
	headers: Record<string, string>;
	allowedEnvVars: string[];
}
export interface HookMcp extends HookBase {
	type: "mcp_tool";
	server: string;
	tool: string;
	input: Record<string, unknown>;
}
export interface HookPrompt extends HookBase {
	type: "prompt";
	prompt: string;
	model?: string;
	continueOnBlock?: boolean;
}
export type HookHandler = HookCommand | HookHttp | HookMcp | HookPrompt;
interface HookGroup {
	/** Regex over the tool name (or the SessionStart/PreCompact trigger); empty or `*` matches all. */
	matcher: string;
	hooks: HookHandler[];
}

export type HookConfig = Record<HookEvent, HookGroup[]>;

export interface HookRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Bytes of stdout and stderr past `OUTPUT_MAX_BYTES` that were not kept (memory stays bounded for a runaway hook). */
	dropped?: { stdout: number; stderr: number };
}


export interface HookVerdict {
	updatedPermissions?: import("../shared/permission-updates.ts").SourcePermissionUpdate[];
	permissionDecision?: "allow" | "deny";
	permissionInterrupt?: true;
	systemMessage?: string;
	haltTurn?: true;
	updatedInput?: JsonObject;
	updatedInputProtocol?: HookProtocol;
	/** Codex post-tool feedback replaces the original result. */
	replaceResult?: true;
	rejectNested?: true;
	/** A source-profile PreCompact veto must reach the core compaction owner. */
	cancelCompaction?: true;
	/** Output rejected by its source protocol; the dispatcher reports/audits this failure. */
	error?: string;
	/** An explicit Stop termination takes precedence over all continuation requests. */
	stop?: true;
	/** Set when the hook blocks: the reason shown to the model. */
	block?: string;
	/** Text the hook adds to the conversation. */
	context?: string;
	continueReason?: string;
	/** Set when a PreToolUse hook answers `permissionDecision: "ask"`: the reason the user is asked with, in every mode. */
	ask?: string;
}
