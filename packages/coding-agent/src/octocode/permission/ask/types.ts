import type { PermissionUpdateCommit, SourcePermissionUpdate } from "../../shared/permission-updates.ts";
import type { FileInputReplacement } from "../../tool-input/claude-file.ts";
import type { JsonObject } from "@octocodeai/octocode-ai";
import type { ExtensionToolContext, ToolInvocation } from "../../../core/features/types.ts";
import type { ExtensionContext } from "../../../core/features/index.ts";
import type { ActionClass, PermissionMode } from "../mode.ts";
import type { SourceDecision } from "../source-policy/rules.ts";
import type { PermissionRequest } from "../request.ts";

/**
 * What a check decided. `lasts` on an allow says how far it reaches: `call` for this call only (the mode allowed it, or the
 * user answered "Allow once"), `session` when it rests on a grant that outlives the call (a session or kind grant, a
 * spawn grant, or the user's answer that made one just now). `bypass`: the mode allowed it and only `bypass` does, so `full`
 * would have asked.
 */
export type Verdict =
	| { allowed: true; via: "mode" | "bypass" | "grant" | "user" | "hook" | "policy"; lasts: "call" | "session" }
	| {
			allowed: false;
			via: "user" | "headless" | "cancelled" | "hook" | "policy";
			message: string;
			/** The user's "Deny <label> for this session": just answered or remembered, it answers later asks too. */
			lasts?: "session";
	  };

/** A call a check let through: what the activity line says about it. */
export interface ActionEvent {
	action: ActionClass | "call";
	/** The first target, one line, redacted, at most 160 characters. */
	what: string;
	/** Destructive shell, browser control or a private network address. */
	warn: boolean;
	mode: PermissionMode;
}

/** A dialog's answer: once, this exact call for the session, every call of its kind for the session, deny (this call, or every later one the grant would match: `deny_session`); undefined when dismissed. */
export type Answer = "once" | "session" | "kind" | "deny" | "deny_session" | { deny: string } | undefined;

/** Where an ask is shown: the parts of a context a dialog needs. */
export type Asker = Pick<ExtensionContext, "hasUI" | "ui"> &
	Partial<Pick<ExtensionContext, "sessionManager" | "abort" | "cwd">> &
	Partial<Pick<ExtensionToolContext, "invocation">>;

export type PermissionResolver = (
	ctx: Asker,
	invocation: ToolInvocation,
	signal: AbortSignal,
) => Promise<
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

/** Stages the permission updates a hook answer carried; the check publishes them once the call is allowed. */
export type PrepareUpdates = (
	ctx: Asker,
	updates: readonly SourcePermissionUpdate[],
	signal: AbortSignal,
) => Promise<PermissionUpdateCommit>;

type ReplacementCommit = (signal: AbortSignal, source: SourceDecision | undefined) => Promise<void>;
export type PrepareReplacement = (
	input: JsonObject,
) => Promise<{ request: PermissionRequest; commit: ReplacementCommit; fileIndices?: number[] }>;
export interface ReplacementCheck {
	updatedPermissions?: SourcePermissionUpdate[];
	prepare?: PrepareReplacement;
	prepareFile?: (inputs: FileInputReplacement[]) => ReturnType<PrepareReplacement>;
	inheritedHookApproval?: boolean;
	commit?: ReplacementCommit;
	auditNote?: string;
	fileIndices?: number[];
}

/** A dialog in place of the default select (the file review). It runs inside `withDialog`. */
export type Dialog = (ctx: Asker, request: PermissionRequest) => Promise<Answer>;
