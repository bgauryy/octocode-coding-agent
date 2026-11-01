import { Value } from "typebox/value";
import { Type, type Static } from "typebox";
import {
	ApplicationAssetSchema,
	ApplicationContentBlockSchema,
	type ApplicationAsset,
	type ApplicationAssetInput,
	type ApplicationAssetPayload,
} from "./content.ts";

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
		},
		{
			additionalProperties: false,
			oneOf: [{ required: ["choice"] }, { required: ["text"] }],
		},
	),
]);
export type ApplicationCommand = Static<typeof ApplicationCommandSchema>;
export type ApplicationCursor = Static<typeof ApplicationCursorSchema>;
export type ApplicationMessage = Static<typeof MessageSchema>;
export type ApplicationReceipt = Static<typeof ReceiptSchema>;
export type ApplicationTool = Static<typeof ApplicationToolSchema>;
export type ApplicationEvent = Static<typeof ApplicationEventSchema>;
export type ApplicationAwaiting = Static<typeof AwaitingSchema>;
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
/** Portable session notices. Persisted entries and live-only notifications have distinct provenance. */
export const ApplicationActivitySchema = Type.Object({
	id: Type.String(),
	kind: Type.String(),
	at: Type.Number(),
	text: Type.String({ maxLength: 4000 }),
	source: Type.Union([Type.Literal("session"), Type.Literal("live")]),
	entryId: Type.Optional(Type.String()),
	data: Type.Optional(Type.Unknown()),
	full: Type.Optional(ApplicationAssetSchema),
	/** Set when the activity reports a failure; absent otherwise, so older clients still read it as neutral. */
	outcome: Type.Optional(Type.Literal("failed")),
});
export type ApplicationActivity = Static<typeof ApplicationActivitySchema>;
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
/**
 * A blocking dialog the run waits on: an approval, or a question or other input. With `id` a client may answer it with
 * the `answer` command: one of `options` (an approval's choices are the host's own words), or `text` where
 * `allowsText`. Without `id` only the terminal can answer (an older host, or an editor or custom dialog).
 */
const AwaitingSchema = Type.Object({
	kind: Type.Union([Type.Literal("approval"), Type.Literal("question")]),
	title: Type.Optional(Type.String({ maxLength: 200 })),
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
	options: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 })),
	allowsText: Type.Optional(Type.Boolean()),
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
	Type.Object({
		type: Type.Literal("session.status"),
		status: Type.Union([Type.Literal("compacting"), Type.Literal("retrying"), Type.Literal("idle")]),
	}),
	Type.Object({
		type: Type.Literal("session.awaiting"),
		/** The blocking dialog now open; absent when none is. */
		awaiting: Type.Optional(AwaitingSchema),
	}),
	Type.Object({
		type: Type.Literal("command.receipt"),
		receipt: ReceiptSchema,
	}),
]);
const SessionStatusSchema = Type.Union([Type.Literal("idle"), Type.Literal("compacting"), Type.Literal("retrying")]);
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
	awaiting: Type.Optional(AwaitingSchema),
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
	protocolVersion: Type.Literal(1),
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
			: command.action === "answer"
				? {
						dialogId: command.dialogId,
						...(command.choice !== undefined ? { choice: command.choice } : {}),
						...(command.text !== undefined ? { text: command.text } : {}),
					}
				: { text: command.text, ...(command.attachments?.length ? { attachments: command.attachments } : {}) }),
	});
}
