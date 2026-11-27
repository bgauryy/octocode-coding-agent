import type { HookEvent } from "../catalog.ts";
import { defaultPolicy, type EventPolicy } from "./event-policy.ts";
import {
	interruptPolicy,
	postCompactPolicy,
	postToolBatchPolicy,
	preCompactPolicy,
	sessionEndPolicy,
	userPromptSubmitPolicy,
} from "./events.ts";
import { notificationPolicy, preMessageSendPolicy } from "./messages.ts";
import { permissionRequestPolicy } from "./permission-request.ts";
import { postToolUsePolicy } from "./post-tool-use.ts";
import { preToolUsePolicy } from "./pre-tool-use.ts";
import { sessionStartPolicy } from "./session-start.ts";
import { stopPolicy } from "./stop.ts";
import { subagentStartPolicy } from "./subagent.ts";

const POLICIES: Partial<Record<HookEvent, EventPolicy>> = {
	Interrupt: interruptPolicy,
	Notification: notificationPolicy,
	PermissionRequest: permissionRequestPolicy,
	PostCompact: postCompactPolicy,
	PostToolBatch: postToolBatchPolicy,
	PostToolUse: postToolUsePolicy,
	PreCompact: preCompactPolicy,
	PreMessageSend: preMessageSendPolicy,
	PreToolUse: preToolUsePolicy,
	SessionEnd: sessionEndPolicy,
	SessionStart: sessionStartPolicy,
	Stop: stopPolicy,
	SubagentStart: subagentStartPolicy,
	SubagentStop: stopPolicy,
	UserPromptSubmit: userPromptSubmitPolicy,
};

/** The rules of `event`: its own policy over the defaults. */
export const policyFor = (event: HookEvent): EventPolicy => ({ ...defaultPolicy, ...POLICIES[event] });
