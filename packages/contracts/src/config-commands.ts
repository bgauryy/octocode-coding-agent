import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

/** Provider ids and the commands of the credential and provider endpoints of the configuration page. */

/** The longest key the page accepts. */
export const MAX_CREDENTIAL_KEY_LENGTH = 8192;

/** The same provider ids the OS keychain accepts (account names), so a key can be stored under any id the page sends. */
export const ProviderIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]*$", minLength: 1, maxLength: 128 });

/**
 * `POST /api/admin/config/credentials`: set or replace one provider's API key, or clear the provider's stored
 * credential. This is the only schema that carries a secret (`key`); it travels in this request body and nowhere else,
 * and no reply, event, log line or audit row repeats it. Without an OS keychain the key is stored as plain text in
 * `auth.json` only when `acknowledgePlaintext` is true.
 */
export const ConfigCredentialCommandSchema = Type.Union([
	Type.Object(
		{
			action: Type.Literal("set"),
			provider: ProviderIdSchema,
			key: Type.String({ minLength: 1, maxLength: MAX_CREDENTIAL_KEY_LENGTH, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
			acknowledgePlaintext: Type.Optional(Type.Boolean()),
			/** Save although the provider could not be reached to check the key (a rejected key is never saved). */
			acknowledgeUnverified: Type.Optional(Type.Boolean()),
			/**
			 * A custom API host for an official provider, saved with the key (checked as in the terminal: https or a
			 * loopback host, no embedded credentials). `region` and `api` apply to providers whose `auth.keyAuth.host`
			 * declares them.
			 */
			host: Type.Optional(Type.String({ maxLength: 2048, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })),
			region: Type.Optional(Type.String({ maxLength: 64, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })),
			api: Type.Optional(Type.String({ maxLength: 64, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("clear"), provider: ProviderIdSchema }, { additionalProperties: false }),
]);
export type ConfigCredentialCommand = Static<typeof ConfigCredentialCommandSchema>;

/** What Octocode assumes for a model whose limits nobody told it; the form shows them and the terminal asks with them. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 16_384;

const TEMPLATE_KINDS = ["hosted", "gateway", "local", "custom"] as const;

/** A provider template the host offers (`snapshot.providerTemplates`): what the form needs, never a key. */
export const ProviderTemplateInfoSchema = Type.Object(
	{
		id: ProviderIdSchema,
		name: Type.String({ minLength: 1, maxLength: 128 }),
		kind: StringEnum(TEMPLATE_KINDS),
		api: Type.String({ minLength: 1, maxLength: 64 }),
		/** The fixed host; without it the user gives one. */
		baseUrl: Type.Optional(Type.String({ maxLength: 2048 })),
		hostHint: Type.Optional(Type.String({ maxLength: 2048 })),
		/** True when `hostHint` is a usable default (a local server's documented address). */
		hostDefault: Type.Optional(Type.Boolean()),
		/** The key variable the vendor documents. */
		keyEnv: Type.Optional(Type.String({ maxLength: 128 })),
		keyOptional: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type ProviderTemplateInfo = Static<typeof ProviderTemplateInfoSchema>;

const TemplateKeyText = Type.String({
	minLength: 1,
	maxLength: MAX_CREDENTIAL_KEY_LENGTH,
	pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});

/**
 * How a provider created from a template gets its key. `keychain` stores it in the OS keychain (models.json holds only
 * a reference); `plaintext` writes it to auth.json and needs `acknowledgePlaintext: true`; `env` references an
 * environment variable; `none` is for a local server that runs without a key. The key travels in this request only.
 */
export const TemplateKeySchema = Type.Union([
	Type.Object({ kind: Type.Literal("keychain"), key: TemplateKeyText }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("plaintext"), key: TemplateKeyText, acknowledgePlaintext: Type.Literal(true) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("env"), name: Type.String({ minLength: 1, maxLength: 128 }) },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
]);

/**
 * `POST /api/admin/config/providers`: turn one provider on or off (the global `disabledProviders` list), or turn the Pi
 * source on or off (the global `providerSources.pi` setting). Neither touches a credential or a configuration file. The
 * reply is the fresh `ConfigSnapshot`.
 */
export const ConfigProviderCommandSchema = Type.Union([
	Type.Object(
		{ action: Type.Literal("set-provider"), provider: ProviderIdSchema, enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
	// Which of a provider's models stay visible: `hidden` replaces the provider's hidden list (empty: show all).
	Type.Object(
		{
			action: Type.Literal("set-models"),
			provider: ProviderIdSchema,
			hidden: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1024 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("set-source"), source: Type.Literal("pi"), enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
	// Custom providers defined in Octocode's models.json (`customEdit` in the snapshot), as the terminal's detail page offers.
	Type.Object(
		{
			action: Type.Literal("edit-host"),
			provider: ProviderIdSchema,
			host: Type.String({ minLength: 1, maxLength: 2048, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("edit-limits"),
			provider: ProviderIdSchema,
			model: Type.String({ minLength: 1, maxLength: 256 }),
			contextWindow: Type.Integer({ minimum: 1 }),
			maxOutput: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("remove-custom"), provider: ProviderIdSchema }, { additionalProperties: false }),
	// A new custom provider from a template (`providerTemplates` in the snapshot), as the terminal's template flow adds it.
	Type.Object(
		{
			action: Type.Literal("create-from-template"),
			template: ProviderIdSchema,
			/** The id the provider is saved under; an official or already defined id is refused. */
			provider: ProviderIdSchema,
			host: Type.Optional(Type.String({ maxLength: 2048, pattern: "^[^\\u0000-\\u001f\\u007f]*$" })),
			models: Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: 256 }),
						/** Written only when given; a model keeps the loader's defaults otherwise (a local server needs both). */
						contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
						maxOutput: Type.Optional(Type.Integer({ minimum: 1 })),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 64 },
			),
			key: TemplateKeySchema,
		},
		{ additionalProperties: false },
	),
]);
export type ConfigProviderCommand = Static<typeof ConfigProviderCommandSchema>;
