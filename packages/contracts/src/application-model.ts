import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The session's model, thinking level, spend and quota as a client sees them, and the commands that change the model
 * and thinking level. Every field here is optional on the snapshot: an older host omits them and never advertises the
 * `setModel` or `setThinking` capability, so a client shows the controls only when the capability is present.
 */

/** The fields every application command carries. */
export const applicationCommandIdentity = {
	id: Type.String({ minLength: 1, maxLength: 128 }),
	sessionId: Type.String({ minLength: 1 }),
};

/** What a client may send; `setModel` and `setThinking` arrived with the model controls. */
export const ApplicationCapabilitySchema = Type.Union([
	Type.Literal("prompt"),
	Type.Literal("steer"),
	Type.Literal("followUp"),
	Type.Literal("abort"),
	Type.Literal("answer"),
	Type.Literal("setModel"),
	Type.Literal("setThinking"),
]);
export type ApplicationCapability = Static<typeof ApplicationCapabilitySchema>;

/** Every thinking level, lowest first; a model offers a subset of them (`ApplicationModel.thinkingLevels`). */
export const APPLICATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ApplicationThinkingLevelSchema = StringEnum(APPLICATION_THINKING_LEVELS);
export type ApplicationThinkingLevel = Static<typeof ApplicationThinkingLevelSchema>;

/** `plan`: a subscription pays, so a dollar figure is an estimate at list price. `metered`: billed per token, money. */
export const ApplicationBillingSchema = StringEnum(["plan", "metered"] as const);
export type ApplicationBilling = Static<typeof ApplicationBillingSchema>;

/**
 * What the model's provider is, in the words the terminal footer shows beside the model: a sign-in or plan key
 * (`subscription`), a vendor CLI (`CLI`), another stored login (`account`), models served from this machine (`local`),
 * or a metered `API key`.
 */
export const ApplicationProviderKindSchema = StringEnum([
	"subscription",
	"API key",
	"account",
	"CLI",
	"local",
] as const);
export type ApplicationProviderKind = Static<typeof ApplicationProviderKindSchema>;

/** The session's selected model. Thinking, billing and kind are absent from an older host. */
export const ApplicationModelSchema = Type.Object({
	provider: Type.String(),
	id: Type.String(),
	name: Type.String(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	thinkingLevel: Type.Optional(ApplicationThinkingLevelSchema),
	/** The levels this model accepts; empty when it has no thinking control. */
	thinkingLevels: Type.Optional(Type.Array(ApplicationThinkingLevelSchema, { maxItems: 7 })),
	billing: Type.Optional(ApplicationBillingSchema),
	kind: Type.Optional(ApplicationProviderKindSchema),
});
export type ApplicationModel = Static<typeof ApplicationModelSchema>;

/** One model `setModel` accepts, for a picker. */
export const ApplicationModelOptionSchema = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 128 }),
	id: Type.String({ minLength: 1, maxLength: 256 }),
	name: Type.String({ maxLength: 256 }),
	billing: ApplicationBillingSchema,
	/** List price in US dollars per million input and output tokens; zero for a model without pricing. */
	cost: Type.Optional(Type.Object({ input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }) })),
	/** The model can think (its levels are known once it is selected). */
	reasoning: Type.Optional(Type.Boolean()),
	contextWindow: Type.Optional(Type.Integer({ minimum: 0 })),
	kind: Type.Optional(ApplicationProviderKindSchema),
});
export type ApplicationModelOption = Static<typeof ApplicationModelOptionSchema>;
const ModelOptionsSchema = Type.Array(ApplicationModelOptionSchema, { maxItems: 2000 });

/** The session's spend so far, money apart from plan estimates (US dollars). */
export const ApplicationUsageSchema = Type.Object({
	/** Billed per token: money. */
	metered: Type.Number({ minimum: 0 }),
	/** Replies a plan paid for, at list price: an estimate, not money. */
	planEstimate: Type.Number({ minimum: 0 }),
	/** Replies that spent tokens on a model without pricing; neither sum includes them. */
	unpriced: Type.Integer({ minimum: 0 }),
	/** How full the context window is, in percent, when the host knows. */
	contextPercent: Type.Optional(Type.Number({ minimum: 0 })),
	/** The window `contextPercent` is of, in tokens: what `/context` and the footer measure against. */
	contextWindow: Type.Optional(Type.Integer({ minimum: 0 })),
	/** Where Octocode compacts automatically, in tokens; the footer's gauge turns red at 80 % of it. */
	compactAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ApplicationUsage = Static<typeof ApplicationUsageSchema>;

/**
 * One quota window of a provider as a response, a CLI event or an error last reported it; never polled. The same shape
 * as `QuotaReading` of the ai package's quota parsers.
 */
export const QuotaReadingSchema = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 128 }),
	/** Stable id of the window within its provider (`primary`, `five_hour`, `requests`). */
	window: Type.String({ minLength: 1, maxLength: 64 }),
	/** The window as a person reads it: `5h`, `week`, `requests`. */
	label: Type.String({ maxLength: 128 }),
	/** Share of the window used, 0 to 1. */
	usedFraction: Type.Number({ minimum: 0, maximum: 1 }),
	/** When the window resets or refills (ms since the epoch); absent when the source named no time. */
	resetsAt: Type.Optional(Type.Number()),
	/** `plan`: a subscription allowance (hours or days). `rate`: an API rate limit that refills within a minute. */
	kind: StringEnum(["plan", "rate"] as const),
	source: StringEnum(["header", "event", "error"] as const),
	/** When the reading was taken (ms since the epoch). */
	observedAt: Type.Number(),
});
export type QuotaReading = Static<typeof QuotaReadingSchema>;
const QuotaSchema = Type.Array(QuotaReadingSchema, { maxItems: 64 });

/** Switch the session to a model the host lists; an unknown model fails the command. */
export const SetModelCommandSchema = Type.Object(
	{
		...applicationCommandIdentity,
		action: Type.Literal("setModel"),
		provider: Type.String({ minLength: 1, maxLength: 128 }),
		modelId: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);

/** Ask for a thinking level; the host clamps it to the levels the current model accepts. */
export const SetThinkingCommandSchema = Type.Object(
	{ ...applicationCommandIdentity, action: Type.Literal("setThinking"), level: ApplicationThinkingLevelSchema },
	{ additionalProperties: false },
);
type ModelCommand = Static<typeof SetModelCommandSchema> | Static<typeof SetThinkingCommandSchema>;

/** The fields after `action` that make two model commands under one id the same request. */
export function modelCommandFields(command: ModelCommand): Record<string, string> {
	return command.action === "setModel"
		? { provider: command.provider, modelId: command.modelId }
		: { level: command.level };
}

export const SessionUsageEventSchema = Type.Object({
	type: Type.Literal("session.usage"),
	usage: ApplicationUsageSchema,
});
/** The latest reading of every quota window the session's providers reported; replaces the previous list. */
export const SessionQuotaEventSchema = Type.Object({ type: Type.Literal("session.quota"), quota: QuotaSchema });
/** The models `setModel` accepts now; replaces the previous list. */
export const SessionModelsEventSchema = Type.Object({
	type: Type.Literal("session.models"),
	models: ModelOptionsSchema,
});

/** Snapshot fields of this module; each is absent until the host publishes it. */
export const applicationModelSnapshotFields = {
	usage: Type.Optional(ApplicationUsageSchema),
	quota: Type.Optional(QuotaSchema),
	models: Type.Optional(ModelOptionsSchema),
};

/** Set on a failed reply whose error is a refused credential, so a client can point at the provider settings. */
export const ApplicationErrorKindSchema = Type.Literal("credential");
