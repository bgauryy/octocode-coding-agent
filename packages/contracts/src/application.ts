import { Value } from "typebox/value";
import { Type, type Static } from "typebox";
import {
	ApplicationAssetSchema,
	ApplicationContentBlockSchema,
	type ApplicationAsset,
	type ApplicationAssetInput,
	type ApplicationAssetPayload,
} from "./content.ts";
import { ApplicationActivitySchema, type ApplicationActivity } from "./application-activity.ts";
export { ApplicationActivitySchema, type ApplicationActivity } from "./application-activity.ts";
import { AwaitingSchema } from "./application-awaiting.ts";
import { ApplicationPhaseSchema, SessionStatusEventSchema, SessionStatusSchema } from "./application-phase.ts";
import { ReplySchema } from "./question.ts";
import { ApplicationToolProgressSchema } from "./tool-progress.ts";
import { ToolDisplaySchema } from "./tool-display.ts";

export const APPLICATION_PROTOCOL_VERSION = 1 as const;
const identity = {
	id: Type.String({ minLength: 1, maxLength: 128 }),
	sessionId: Type.String({ minLength: 1 }),
};
export const ApplicationCommandSchema = Type.Union([
	Type.Object(
		{
			...identity,
			action: Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")]),
			text: Type.String({ maxLength: 64000 }),
			attachments: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
		},
		{
			additionalProperties: false,
			anyOf: [
				{ properties: { text: { minLength: 1 } } },
				{ required: ["attachments"], properties: { attachments: { minItems: 1 } } },
			],
		},
	),
	Type.Object(
		{
			...identity,
			action: Type.Literal("abort"),
			runId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	// An answer to the blocking dialog `awaiting` names: one of its options, or text where it accepts text.
	Type.Object(
		{
			...identity,
			action: Type.Literal("answer"),
			dialogId: Type.String({ minLength: 1, maxLength: 64 }),
			choice: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			text: Type.Optional(Type.String({ maxLength: 4000 })),
			/** The answers to a dialog that asks typed questions (`awaiting.questions`): one reply per question id, picks by option id. */
			replies: Type.Optional(Type.Array(ReplySchema, { maxItems: 8 })),
		},
		{
			additionalProperties: false,
			oneOf: [{ required: ["choice"] }, { required: ["text"] }, { required: ["replies"] }],
		},
	),
	// The person started answering the dialog `awaiting` names: the host stops any countdown over it (askUser's `timeout`).
	Type.Object(
		{ ...identity, action: Type.Literal("hold"), dialogId: Type.String({ minLength: 1, maxLength: 64 }) },
		{ additionalProperties: false },
	),
]);
export type ApplicationCommand = Static<typeof ApplicationCommandSchema>;
export type ApplicationCursor = Static<typeof ApplicationCursorSchema>;
export type ApplicationMessage = Static<typeof MessageSchema>;
export type ApplicationReceipt = Static<typeof ReceiptSchema>;
export type ApplicationTool = Static<typeof ApplicationToolSchema>;
export type ApplicationEvent = Static<typeof ApplicationEventSchema>;
export type ApplicationAwaiting = Static<typeof AwaitingSchema>;
export { isPendingApplicationPhase, isTerminalApplicationPhase, type ApplicationPhase } from "./application-phase.ts";
export type ApplicationSnapshot = Static<typeof ApplicationSnapshotSchema>;
export type ApplicationFrame = Static<typeof ApplicationFrameSchema>;
export interface ApplicationConnection extends AsyncIterable<ApplicationFrame> {
	execute(command: ApplicationCommand): Promise<ApplicationReceipt>;
	close(): void;
}
export interface ApplicationPort {
	connect(options?: { sessionId?: string; cursor?: ApplicationCursor }): ApplicationConnection;
	execute(command: ApplicationCommand): Promise<ApplicationReceipt>;
	readAsset?(
		id: string,
		sessionId?: string,
	): ApplicationAssetPayload | undefined | Promise<ApplicationAssetPayload | undefined>;
	uploadAsset?(input: ApplicationAssetInput, sessionId?: string): ApplicationAsset | Promise<ApplicationAsset>;
	history?(options?: {
		before?: string;
		activityBefore?: string;
		limit?: number;
		sessionId?: string;
	}): ApplicationHistory | Promise<ApplicationHistory>;
}

/** Where an item first appeared among the session's messages and tools, so a snapshot keeps their interleaving. */
const OrderSchema = Type.Optional(Type.Integer({ minimum: 0 }));

const MessageSchema = Type.Object({
	id: Type.String(),
	role: Type.String(),
	text: Type.String(),
	complete: Type.Boolean(),
	order: OrderSchema,
	content: Type.Optional(Type.Array(ApplicationContentBlockSchema)),
	full: Type.Optional(ApplicationAssetSchema),
	status: Type.Optional(
		Type.Union([
			Type.Literal("streaming"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("aborted"),
			Type.Literal("interrupted"),
		]),
	),
	timestamp: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	responseId: Type.Optional(Type.String()),
	stopReason: Type.Optional(Type.String()),
	errorMessage: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	toolCallId: Type.Optional(Type.String()),
	customType: Type.Optional(Type.String()),
	/** Host policy for context-only custom messages; consumers must not display false. */
	display: Type.Optional(Type.Boolean()),
	details: Type.Optional(Type.Unknown()),
});
const toolData = {
	content: Type.Optional(Type.Array(ApplicationContentBlockSchema)),
	/** Set by partial updates of a running tool that reports progress; a later update or the result replaces it. */
	progress: Type.Optional(ApplicationToolProgressSchema),
	/** How every surface draws the call, built on the host from the tool's arguments and result. */
	display: Type.Optional(ToolDisplaySchema),
	/** When the call started running (ms since the epoch), so views show elapsed time without their own clock state. */
	startedAt: Type.Optional(Type.Number()),
	arguments: Type.Optional(Type.Unknown()),
	parentToolCallId: Type.Optional(Type.String()),
	messageId: Type.Optional(Type.String()),
	durationMs: Type.Optional(Type.Number()),
	structuredContent: Type.Optional(Type.Unknown()),
	details: Type.Optional(Type.Unknown()),
	usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	full: Type.Optional(ApplicationAssetSchema),
	/** With status "failed": the tool never ran because its model response failed. Older clients show it as failed. */
	notRun: Type.Optional(Type.Literal(true)),
};
const ReceiptSchema = Type.Object({
	id: Type.String(),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("completed"), Type.Literal("failed")]),
	message: Type.Optional(Type.String()),
});
export const ApplicationToolSchema = Type.Object({
	toolCallId: Type.String(),
	order: OrderSchema,
	toolName: Type.String(),
	hint: Type.Optional(Type.String({ maxLength: 200 })),
	text: Type.String(),
	status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
	...toolData,
});
export const ApplicationErrorSchema = Type.Object({
	type: Type.Literal("application.error"),
	id: Type.String(),
	code: Type.Literal("content-unavailable"),
	message: Type.String({ maxLength: 1000 }),
});
export type ApplicationError = Static<typeof ApplicationErrorSchema>;
const activityState = {
	activities: Type.Optional(Type.Array(ApplicationActivitySchema)),
	activityBefore: Type.Optional(Type.String()),
	hasMoreActivities: Type.Optional(Type.Boolean()),
};
const ApplicationModelSchema = Type.Object({
	provider: Type.String(),
	id: Type.String(),
	name: Type.String(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
});
export const ApplicationEventSchema = Type.Union([
	ApplicationErrorSchema,
	Type.Object({ type: Type.Literal("session.model"), model: Type.Optional(ApplicationModelSchema) }),
	Type.Object({ type: Type.Literal("session.activity"), activity: ApplicationActivitySchema }),
	Type.Object({
		type: Type.Literal("session.reset"),
		messages: Type.Array(MessageSchema),
		tools: Type.Array(ApplicationToolSchema),
		errors: Type.Optional(Type.Array(ApplicationErrorSchema)),
		...activityState,
	}),
	Type.Object({
		type: Type.Union([Type.Literal("message.started"), Type.Literal("message.completed")]),
		message: MessageSchema,
	}),
	Type.Object({
		type: Type.Literal("message.delta"),
		messageId: Type.String(),
		delta: Type.String(),
		/**
		 * Append-only form: `delta` extends `content[index]` (see `appendApplicationMessage`) and `text`, `content` and
		 * `full` are omitted. Without it, `text`, `content` and `full` replace the message's.
		 */
		block: Type.Optional(
			Type.Object({
				index: Type.Integer({ minimum: 0 }),
				length: Type.Integer({ minimum: 0 }),
				full: Type.Optional(ApplicationAssetSchema),
			}),
		),
		text: Type.Optional(Type.String()),
		/** Authoritative ordered blocks, including reasoning and non-text updates. */
		content: Type.Optional(Type.Array(ApplicationContentBlockSchema)),
		full: Type.Optional(ApplicationAssetSchema),
	}),
	Type.Object({
		type: Type.Union([Type.Literal("tool.started"), Type.Literal("tool.progress"), Type.Literal("tool.completed")]),
		toolCallId: Type.String(),
		toolName: Type.String(),
		order: OrderSchema,
		/** A short, redacted label from the call's arguments (a path, command or query); sent with tool.started. */
		hint: Type.Optional(Type.String({ maxLength: 200 })),
		text: Type.Optional(Type.String()),
		failed: Type.Optional(Type.Boolean()),
		...toolData,
	}),
	Type.Object({ type: Type.Literal("run.started"), runId: Type.String() }),
	Type.Object({
		type: Type.Literal("run.settled"),
		runId: Type.String(),
		aborted: Type.Boolean(),
	}),
	Type.Object({
		type: Type.Literal("queue.changed"),
		steering: Type.Array(Type.String()),
		followUp: Type.Array(Type.String()),
	}),
	SessionStatusEventSchema,
	Type.Object({
		type: Type.Literal("session.awaiting"),
		/** The blocking dialog now open; absent when none is. */
		awaiting: Type.Optional(AwaitingSchema),
	}),
	Type.Object({
		type: Type.Literal("session.phase"),
		/** What the session is doing now; a run that settled while agents or timers remain is `waiting` or `scheduled`, not done. */
		phase: ApplicationPhaseSchema,
		/** While the phase is not terminal: when the job it belongs to started (ms since the epoch). */
		jobStartedAt: Type.Optional(Type.Number()),
	}),
	Type.Object({
		type: Type.Literal("command.receipt"),
		receipt: ReceiptSchema,
	}),
]);
export const ApplicationCursorSchema = Type.Object({
	sessionId: Type.String(),
	epoch: Type.String(),
	sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const ApplicationSnapshotSchema = Type.Object({
	...activityState,
	model: Type.Optional(ApplicationModelSchema),
	errors: Type.Optional(Type.Array(ApplicationErrorSchema)),
	tools: Type.Optional(Type.Array(ApplicationToolSchema)),
	status: Type.Optional(SessionStatusSchema),
	statusDetail: Type.Optional(Type.String()),
	/** When `status` ends on its own (ms since the epoch): a retry's start. */
	statusUntil: Type.Optional(Type.Number()),
	awaiting: Type.Optional(AwaitingSchema),
	/** Absent until the host publishes one (an older host never does). */
	phase: Type.Optional(ApplicationPhaseSchema),
	jobStartedAt: Type.Optional(Type.Number()),
	sessionId: Type.String(),
	runId: Type.Optional(Type.String()),
	messages: Type.Array(MessageSchema),
	streaming: Type.Boolean(),
	steering: Type.Array(Type.String()),
	followUp: Type.Array(Type.String()),
	receipts: Type.Array(ReceiptSchema),
	capabilities: Type.Array(
		Type.Union([
			Type.Literal("prompt"),
			Type.Literal("steer"),
			Type.Literal("followUp"),
			Type.Literal("abort"),
			Type.Literal("answer"),
		]),
	),
});
const frameFields = {
	protocolVersion: Type.Literal(APPLICATION_PROTOCOL_VERSION),
	cursor: ApplicationCursorSchema,
	at: Type.Number(),
};

export interface ApplicationHistory {
	messages: ApplicationMessage[];
	tools: ApplicationTool[];
	before?: string;
	hasMore: boolean;
	activities?: ApplicationActivity[];
	activityBefore?: string;
	hasMoreActivities?: boolean;
}
export const ApplicationFrameSchema = Type.Union([
	Type.Object({
		...frameFields,
		type: Type.Literal("snapshot"),
		snapshot: ApplicationSnapshotSchema,
	}),
	Type.Object({
		...frameFields,
		type: Type.Literal("event"),
		/** Inclusive first sequence represented by a coalesced delta (joined appends, or the latest full text); omitted otherwise. */
		fromSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		event: ApplicationEventSchema,
	}),
	Type.Object({ ...frameFields, type: Type.Literal("resumed") }),
	Type.Object({
		...frameFields,
		type: Type.Literal("resync"),
		reason: Type.Union([Type.Literal("overflow"), Type.Literal("session-changed")]),
	}),
]);

export function parseApplicationFrame(value: unknown): ApplicationFrame | undefined {
	return Value.Check(ApplicationFrameSchema, value) ? value : undefined;
}

export function parseApplicationMessage(value: unknown): ApplicationMessage | undefined {
	return Value.Check(MessageSchema, value) ? value : undefined;
}

export function parseApplicationTool(value: unknown): ApplicationTool | undefined {
	return Value.Check(ApplicationToolSchema, value) ? value : undefined;
}

export type ApplicationOperation<Operations> = {
	[K in keyof Operations]: Operations[K] extends (...args: never[]) => unknown ? K : never;
}[keyof Operations];
export type ApplicationOperationArgs<Operations, K extends ApplicationOperation<Operations>> = Operations[K] extends (
	...args: infer Args
) => unknown
	? Args
	: never;
export type ApplicationOperationResult<Operations, K extends ApplicationOperation<Operations>> = Operations[K] extends (
	...args: never[]
) => infer Result
	? Result
	: never;

/** Copied host snapshots; subscribing does not start work or transfer mutation authority to a view. */
export interface ApplicationStateSource {
	getSnapshot(): ApplicationSnapshot;
	subscribeState(listener: (snapshot: ApplicationSnapshot) => void): () => void;
}

export interface LocalApplicationPort<Event, Operations> extends ApplicationPort, ApplicationStateSource {
	subscribeNative(listener: (event: Event) => void): () => void;
	invoke<K extends ApplicationOperation<Operations>>(
		operation: K,
		...args: ApplicationOperationArgs<Operations, K>
	): ApplicationOperationResult<Operations, K>;
}

export function applicationCommandFingerprint(command: ApplicationCommand): string {
	return JSON.stringify({
		id: command.id,
		sessionId: command.sessionId,
		action: command.action,
		...(command.action === "abort"
			? { runId: command.runId }
			: command.action === "hold"
				? { dialogId: command.dialogId }
				: command.action === "answer"
					? {
							dialogId: command.dialogId,
							...(command.choice !== undefined ? { choice: command.choice } : {}),
							...(command.text !== undefined ? { text: command.text } : {}),
							...(command.replies !== undefined ? { replies: command.replies } : {}),
						}
					: { text: command.text, ...(command.attachments?.length ? { attachments: command.attachments } : {}) }),
	});
}
