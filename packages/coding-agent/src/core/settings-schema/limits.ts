import { Type } from "typebox";

const Amount = (description: string) => Type.Optional(Type.Number({ exclusiveMinimum: 0, description }));
const Count = (minimum: number, description: string) => Type.Optional(Type.Integer({ minimum, description }));

const CompactionLimits = Type.Optional(
	Type.Object(
		{
			trigger: Amount(
				"Context size at which automatic compaction starts: a share of the working window (0.1 to 1) or a token count (above 1). It can only compact earlier than the built-in point, which keeps room for the reply and the summary; a later value has no effect.",
			),
			keepRecent: Amount(
				"The newest conversation kept word for word across a compaction: a share of the working window (up to 0.25) or a token count (above 1, at most a quarter of the window). Default: 10% of the window, at least 20,000 tokens.",
			),
		},
		{ additionalProperties: false },
	),
);

const ClearingLimits = Type.Optional(
	Type.Object(
		{
			keepTurns: Count(1, "Assistant turns whose tool results are never cleared. Default 10."),
			keepInUseTokens: Count(
				0,
				"Tokens of older tool results kept because a recent message names their path. Default 20,000.",
			),
		},
		{ additionalProperties: false },
	),
);

const RequestLimits = (description: string) =>
	Type.Optional(Type.Object({ maxRequests: Count(0, description) }, { additionalProperties: false }));

const RunLimits = RequestLimits(
	"Model requests one run of the main session may make (from a prompt until the agent stops): a note at this count, a stop at 1.5 times it. 0 turns it off. Default: off when a user is present, 300 for a run without one. Read from the global settings file only.",
);

const SubagentLimits = RequestLimits(
	"Model requests a subagent task may make: a note at this count, a stop at 1.5 times it. 0 turns it off. An agent profile's `maxRequests` wins. Default 160. Read from the global settings file only.",
);

const LoopLimits = Type.Optional(
	Type.Object(
		{
			noteAt: Count(2, "Identical calls with identical results in a row that earn the first note. Default 3."),
			stopAt: Count(3, "The count that earns the stronger note. Default 5."),
			haltAt: Count(4, "The count after which the same call is refused and the run ends. Default 8."),
		},
		{
			additionalProperties: false,
			description: "The repeated-call guard. The three counts must rise: noteAt, stopAt, haltAt.",
		},
	),
);

const PER_MODEL = {
	compaction: CompactionLimits,
	clearing: ClearingLimits,
	run: RunLimits,
	subagent: SubagentLimits,
	loop: LoopLimits,
};

/** The `limits` settings: one block for every size, count and spend bound, with per-model overrides (`core/limits.ts`). */
export const LimitsSchema = Type.Object(
	{
		...PER_MODEL,
		cost: Type.Optional(
			Type.Object(
				{
					max: Amount(
						"US dollars billed per token, the session's own and its subagents', past which the session sends no further model request and starts no subagent. Usage a plan covers never counts. Read from the global settings file only.",
					),
					warnAt: Amount(
						"US dollars at which you are told once what the session has spent. Read from the global settings file only.",
					),
				},
				{ additionalProperties: false },
			),
		),
		models: Type.Optional(
			Type.Record(Type.String({ minLength: 1 }), Type.Object(PER_MODEL, { additionalProperties: false }), {
				description:
					'Overrides for one model, keyed `provider/model`; `*` matches any run of characters, e.g. { "ollama/*": { "compaction": { "trigger": 0.7 } } }. An exact key wins over a pattern, and a longer pattern over a shorter one.',
			}),
		),
	},
	{
		description:
			"Bounds on context, repetition, requests and spend. Every key is optional and falls back to the built-in value for the model in use.",
		additionalProperties: false,
	},
);
