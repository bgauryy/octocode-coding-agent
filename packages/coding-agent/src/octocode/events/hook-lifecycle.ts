/**
 * The lifecycle events a hook can run on, as event topics (`hook.<Event>`). The list mirrors the hook catalog
 * (`hooks/catalog.ts`; a test holds them equal) because `events/` cannot import `hooks/`.
 */
export const HOOK_LIFECYCLE_EVENTS = [
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
	"AgentOn",
	"AgentQueued",
	"AgentOff",
	"TaskCreated",
	"TaskCompleted",
	"BacklogChange",
	"MonitorAlert",
	"UserPromptSubmit",
	"PreCompact",
	"PostCompact",
	"Stop",
	"StopFailure",
	"Notification",
	"PreMessageSend",
	"PostMessageReceive",
] as const;

export type HookLifecycleEvent = (typeof HOOK_LIFECYCLE_EVENTS)[number];
export type HookLifecycleTopic = `hook.${HookLifecycleEvent}`;

/**
 * What the log keeps of one hook run: which run it is (`token`, per process), what the matcher saw, and the handler kinds
 * configured for the event. Never the hook's input, which can hold file text and secrets.
 */
export interface HookLifecyclePayload {
	token: number;
	names: string[];
	kinds: string[];
}

export const hookTopic = (event: HookLifecycleEvent): HookLifecycleTopic => `hook.${event}`;

const LIFECYCLE_TOPICS: ReadonlySet<string> = new Set(HOOK_LIFECYCLE_EVENTS.map(hookTopic));

/** Whether a topic is a lifecycle run (`hook.PreToolUse`), as opposed to `hook.feedback`. */
export const isLifecycleTopic = (topic: string): topic is HookLifecycleTopic => LIFECYCLE_TOPICS.has(topic);
