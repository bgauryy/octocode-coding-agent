import { Value } from "typebox/value";
import { Type, type Static } from "typebox";

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
			text: Type.String({ minLength: 1, maxLength: 64000 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...identity,
			action: Type.Literal("abort"),
			runId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);
export type ApplicationCommand = Static<typeof ApplicationCommandSchema>;
export type ApplicationCursor = Static<typeof ApplicationCursorSchema>;
export type ApplicationMessage = Static<typeof MessageSchema>;
export type ApplicationReceipt = Static<typeof ReceiptSchema>;
export type ApplicationTool = Static<typeof ApplicationToolSchema>;
export type ApplicationEvent = Static<typeof ApplicationEventSchema>;
export type ApplicationSnapshot = Static<typeof ApplicationSnapshotSchema>;
export type ApplicationFrame = Static<typeof ApplicationFrameSchema>;
export interface ApplicationConnection extends AsyncIterable<ApplicationFrame> {
	execute(command: ApplicationCommand): Promise<ApplicationReceipt>;
	close(): void;
}
export interface ApplicationPort {
	connect(options?: { sessionId?: string; cursor?: ApplicationCursor }): ApplicationConnection;
	execute(command: ApplicationCommand): Promise<ApplicationReceipt>;
}

/** Where an item first appeared among the session's messages and tools, so a snapshot keeps their interleaving. */
const OrderSchema = Type.Optional(Type.Integer({ minimum: 0 }));

const MessageSchema = Type.Object({
	id: Type.String(),
	role: Type.String(),
	text: Type.String(),
	complete: Type.Boolean(),
	order: OrderSchema,
});
const ReceiptSchema = Type.Object({
	id: Type.String(),
	status: Type.Union([Type.Literal("accepted"), Type.Literal("completed"), Type.Literal("failed")]),
	message: Type.Optional(Type.String()),
});
export const ApplicationEventSchema = Type.Union([
	Type.Object({
		type: Type.Union([Type.Literal("message.started"), Type.Literal("message.completed")]),
		message: MessageSchema,
	}),
	Type.Object({
		type: Type.Literal("message.delta"),
		messageId: Type.String(),
		delta: Type.String(),
		text: Type.Optional(Type.String()),
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
		type: Type.Literal("command.receipt"),
		receipt: ReceiptSchema,
	}),
]);
const SessionStatusSchema = Type.Union([Type.Literal("idle"), Type.Literal("compacting"), Type.Literal("retrying")]);
export const ApplicationToolSchema = Type.Object({
	toolCallId: Type.String(),
	order: OrderSchema,
	toolName: Type.String(),
	hint: Type.Optional(Type.String({ maxLength: 200 })),
	text: Type.String(),
	status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
});
export const ApplicationCursorSchema = Type.Object({
	sessionId: Type.String(),
	epoch: Type.String(),
	sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export const ApplicationSnapshotSchema = Type.Object({
	tools: Type.Optional(Type.Array(ApplicationToolSchema)),
	status: Type.Optional(SessionStatusSchema),
	sessionId: Type.String(),
	runId: Type.Optional(Type.String()),
	messages: Type.Array(MessageSchema),
	streaming: Type.Boolean(),
	steering: Type.Array(Type.String()),
	followUp: Type.Array(Type.String()),
	receipts: Type.Array(ReceiptSchema),
	capabilities: Type.Array(
		Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("abort")]),
	),
});
const frameFields = {
	protocolVersion: Type.Literal(1),
	cursor: ApplicationCursorSchema,
	at: Type.Number(),
};
export const ApplicationFrameSchema = Type.Union([
	Type.Object({
		...frameFields,
		type: Type.Literal("snapshot"),
		snapshot: ApplicationSnapshotSchema,
	}),
	Type.Object({
		...frameFields,
		type: Type.Literal("event"),
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
	return Value.Check(ApplicationFrameSchema, value) ? (value as ApplicationFrame) : undefined;
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

export interface LocalApplicationPort<Event, Operations> extends ApplicationPort {
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
		...(command.action === "abort" ? { runId: command.runId } : { text: command.text }),
	});
}
