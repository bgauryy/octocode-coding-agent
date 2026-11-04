import type { ToolInvocation } from "../../core/features/types.ts";
import type { ActionClass, AskReason, PermissionMode } from "./mode.ts";

/** What an ask shows: the effect card, any reasons that tighten it, and exactly what it would do. */
export interface PermissionRequest {
	/** Explicit invocation for checks before execution (including user-authored shell commands). */
	invocation?: ToolInvocation;
	/** The effect. Absent when a reason forces a call that has no action class. */
	action?: ActionClass;
	/** Other classes the same call is, each of which must also be allowed (an upload from outside the workspace is browser control and an outside upload): one prompt names them all, and no session grant answers it. */
	also?: readonly ActionClass[];
	/** Reasons that can apply to this call. A reason only tightens: it never loosens the effect's own rule. In full none asks, but each is recorded. */
	reasons?: readonly AskReason[];
	/** A verb and the action: "Run this command?". */
	title: string;
	/** What exactly: the command, path, host or arguments (model text; sanitized when shown). */
	what: string[];
	/** The system's reasons beyond the mode (a hook's reason, a provenance source), one per line. Never agent text. */
	reason?: string;
	/**
	 * What the agent says the call is for, unverified. Source order: the tool's own field, then the last sentence of the
	 * assistant message that issued the call (`toolCallId`), then `no reason given`. An empty string means no agent is
	 * involved (a command the user typed) and the card shows no such line.
	 */
	purpose?: string;
	/** `purpose` was derived from the arguments (`derivedReason`), not written by the agent. */
	reasonDerived?: boolean;
	/** The assistant call this check belongs to: where `purpose` falls back to. */
	toolCallId?: string;
	/** The folder the call runs in (a snapshot's repository, the card's measurements). */
	cwd?: string;
	/** What the model should do when no one can be asked, instead of the general advice to ask the user. */
	nextStep?: string;
	/** The card's lines; computed from the class when the caller does not set them. */
	effect?: string;
	undo?: string;
	risk?: string;
	/** Offered as "Allow <label> for this session"; `key` is what the grant matches next time. */
	grant?: { key: string; label: string };
	/** Issued by another tool (`parentToolCallId` set). */
	nested?: boolean;
	/** The mode whose rules judge this call, when a stricter constraint than the session's mode holds it (plan). */
	asMode?: PermissionMode;
	/** Called once when this call will wait for the user, so whoever is behind it can be told. */
	onAsk?: () => void;
	signal?: AbortSignal;
}
