import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/**
 * The configuration page's Test and Test all. One command names a connected provider (or none: every connected provider
 * and external agent); the host runs the same check as the terminal's `/providers` Test and answers one result per
 * provider. Testing is the only thing that spends: a provider that has no model list costs one small request. A result
 * carries the provider's error text with keys redacted, never a key. `DAEMON_ROUTES.configProviderTest` is under
 * `/api/admin/`, so only the launch capability can press it.
 */

export const PROVIDER_TEST_STATUSES = ["ok", "failed", "skipped"] as const;
/** How a provider answered: its model list (free), one small request, an external agent's own status command. */
export const PROVIDER_TEST_VIAS = ["list", "check", "runner", "none"] as const;

export const ProviderTestCommandSchema = Type.Object(
	{ provider: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
	{ additionalProperties: false },
);
export type ProviderTestCommand = Static<typeof ProviderTestCommandSchema>;

/** A configured model id the host does not serve, with the served ids nearest to it. */
export const UnservedModelSchema = Type.Object(
	{
		id: Type.String({ maxLength: 256 }),
		suggestions: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 3 }),
	},
	{ additionalProperties: false },
);

export const ProviderTestResultSchema = Type.Object(
	{
		/** A provider id, or an external agent id when `kind` is `runner`. */
		id: Type.String({ minLength: 1, maxLength: 128 }),
		name: Type.String({ maxLength: 120 }),
		kind: StringEnum(["provider", "runner"] as const),
		status: StringEnum(PROVIDER_TEST_STATUSES),
		via: StringEnum(PROVIDER_TEST_VIAS),
		/** One line: what answered, or the error text (keys redacted). */
		message: Type.String({ maxLength: 800 }),
		/** How many models the host's own list named; absent when the provider has no list. */
		served: Type.Optional(Type.Integer({ minimum: 0 })),
		/** Configured ids the host's list lacks; absent when nothing was compared. */
		unserved: Type.Optional(Type.Array(UnservedModelSchema, { maxItems: 50 })),
		/** Served ids, a few, shown when none is near an unserved id. */
		servedSample: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 5 })),
		at: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type ProviderTestResult = Static<typeof ProviderTestResultSchema>;

export const ProviderTestReportSchema = Type.Object(
	{ results: Type.Array(ProviderTestResultSchema, { maxItems: 256 }) },
	{ additionalProperties: false },
);
export type ProviderTestReport = Static<typeof ProviderTestReportSchema>;
