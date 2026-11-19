import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";
import { AgentRouteSchema } from "./agent-route.ts";

export * from "./harness-config.ts";
export * from "./mcp-add.ts";
export * from "./tool-exposure.ts";
export * from "./security-config.ts";
export * from "./config-settings.ts";
export * from "./agent-route.ts";

/** Version of the configuration read model; bump when a field changes meaning. */
export const CONFIG_PROTOCOL_VERSION = 1 as const;

/**
 * Where a provider credential comes from. Only the kind is reported: never a key, a `!` reference or any text that
 * was read from `auth.json`.
 */
export const CREDENTIAL_SOURCES = ["keychain", "auth-json", "custom-command", "env", "oauth"] as const;
export const CredentialSourceSchema = StringEnum(CREDENTIAL_SOURCES);
export type CredentialSource = Static<typeof CredentialSourceSchema>;

/** A variable name such as `OPENAI_API_KEY`. The pattern keeps a value or a sentence from fitting in the field. */
const EnvVarNameSchema = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 128 });

export const CredentialSourceStatusSchema = Type.Object(
	{
		kind: CredentialSourceSchema,
		/** For `env`: the variable that is set (never its value). */
		envVar: Type.Optional(EnvVarNameSchema),
		/** For `oauth`: when the access token expires, in epoch milliseconds, if known. */
		expiresAt: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type CredentialSourceStatus = Static<typeof CredentialSourceStatusSchema>;

/** The sign-ins a provider offers: an account or subscription sign-in run by the host, and an API key. */
export const ProviderAuthMethodsSchema = Type.Object(
	{
		oauth: Type.Optional(
			Type.Object(
				{
					name: Type.String({ minLength: 1, maxLength: 128 }),
					/** True when the sign-in is backed by a paid subscription (such as ChatGPT or Copilot). */
					isSubscription: Type.Optional(Type.Boolean()),
					loginLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				},
				{ additionalProperties: false },
			),
		),
		keyAuth: Type.Optional(
			Type.Object(
				{
					name: Type.String({ minLength: 1, maxLength: 128 }),
					/** The provider's page that issues keys; always an https link. */
					keyPage: Type.Optional(Type.String({ pattern: "^https://[^\\s]+$", maxLength: 512 })),
				},
				{ additionalProperties: false },
			),
		),
		plan: Type.Optional(
			Type.Object(
				{
					billing: StringEnum(["plan", "metered"] as const),
					terms: Type.String({ minLength: 1, maxLength: 2048 }),
					deprecated: Type.Optional(Type.String({ maxLength: 2048 })),
					disabled: Type.Optional(Type.String({ maxLength: 2048 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type ProviderAuthMethods = Static<typeof ProviderAuthMethodsSchema>;

/** The products whose configuration feeds the provider list. */
export const PROVIDER_PRODUCTS = ["octocode", "pi"] as const;
export const ProviderProductSchema = StringEnum(PROVIDER_PRODUCTS);
export type ProviderProduct = Static<typeof ProviderProductSchema>;

/**
 * A place a provider is configured: a product's `auth.json` (a credential is stored) or `models.json` (the provider is
 * defined or overridden there; `hasKey` says only whether it sets an `apiKey`, never the key).
 */
export const ProviderOriginSchema = Type.Object(
	{
		product: ProviderProductSchema,
		file: StringEnum(["auth-json", "models-json"] as const),
		hasKey: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type ProviderOrigin = Static<typeof ProviderOriginSchema>;

/** A provider source: Octocode's own configuration (always on) or Pi's (on by default, can be turned off). */
export const ProviderSourceStateSchema = Type.Object(
	{
		id: ProviderProductSchema,
		label: Type.String({ minLength: 1, maxLength: 64 }),
		enabled: Type.Boolean(),
		/** False for Octocode: its own configuration cannot be turned off. */
		toggleable: Type.Boolean(),
		/** Some file of the source exists. Its content is never reported. */
		present: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type ProviderSourceState = Static<typeof ProviderSourceStateSchema>;

/**
 * Which credential sources exist for a provider. Several can exist at once; the model says which are present, not which
 * one a request uses.
 */
export const ProviderCredentialStatusSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: 128 }),
		/** Display name, when the provider is known. */
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		/** True when at least one source is present. */
		configured: Type.Boolean(),
		/** `false` when the credential endpoint would refuse this provider id, so the page offers no Set, Replace or Clear. */
		editable: Type.Optional(Type.Boolean()),
		sources: Type.Array(CredentialSourceStatusSchema, { maxItems: 16 }),
		/** The configuration files that define or hold credentials for the provider, by product. Pi's only while its source is on. */
		origins: Type.Optional(Type.Array(ProviderOriginSchema, { maxItems: 8 })),
		/** True when the user turned the provider off: its models are hidden and its credentials are kept. */
		disabled: Type.Optional(Type.Boolean()),
		/** The sign-ins the provider offers. Names and a public link only: never a credential. */
		auth: Type.Optional(ProviderAuthMethodsSchema),
		/** How a request through the provider is billed (`config` or `subscription`), derived from its sign-ins and sources. */
		route: Type.Optional(AgentRouteSchema),
	},
	{ additionalProperties: false },
);
export type ProviderCredentialStatus = Static<typeof ProviderCredentialStatusSchema>;

export const SETTING_SOURCES = ["global", "workspace", "default"] as const;
export const SettingSourceSchema = StringEnum(SETTING_SOURCES);
export type SettingSource = Static<typeof SettingSourceSchema>;

export const ConfigSettingSchema = Type.Object(
	{
		/** An allow-listed setting key, such as `defaultProvider`. */
		key: Type.String({ minLength: 1, maxLength: 128 }),
		/** The effective value; absent when the setting is unset. */
		value: Type.Optional(Type.Unknown()),
		source: SettingSourceSchema,
	},
	{ additionalProperties: false },
);
export type ConfigSetting = Static<typeof ConfigSettingSchema>;

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
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("clear"), provider: ProviderIdSchema }, { additionalProperties: false }),
]);
export type ConfigCredentialCommand = Static<typeof ConfigCredentialCommandSchema>;

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
	Type.Object(
		{ action: Type.Literal("set-source"), source: Type.Literal("pi"), enabled: Type.Boolean() },
		{ additionalProperties: false },
	),
]);
export type ConfigProviderCommand = Static<typeof ConfigProviderCommandSchema>;

/** A settings file that could not be read. The text is fixed; parser messages can quote file content. */
export const SettingsFileErrorSchema = Type.Object(
	{ scope: StringEnum(["global", "workspace"] as const), message: Type.String({ maxLength: 200 }) },
	{ additionalProperties: false },
);
export type SettingsFileError = Static<typeof SettingsFileErrorSchema>;

export const ConfigWorkspaceSchema = Type.Object(
	{ repo: Type.String({ minLength: 1, maxLength: 256 }), trusted: Type.Boolean() },
	{ additionalProperties: false },
);
export type ConfigWorkspace = Static<typeof ConfigWorkspaceSchema>;

/** The configuration page's model. It never carries a secret, a key value or `!` reference text. */
export const ConfigSnapshotSchema = Type.Object(
	{
		protocolVersion: Type.Literal(CONFIG_PROTOCOL_VERSION),
		generatedAt: Type.Number({ minimum: 0 }),
		/** Whether this machine has an OS keychain tool (macOS Keychain, Secret Service). */
		keychainAvailable: Type.Boolean(),
		providers: Type.Array(ProviderCredentialStatusSchema),
		/** Where providers come from: Octocode and Pi, with their state. */
		sources: Type.Optional(Type.Array(ProviderSourceStateSchema, { maxItems: 4 })),
		/** Present when `auth.json` could not be read; the text is fixed because parser messages can quote file content. */
		credentialsError: Type.Optional(Type.String({ maxLength: 200 })),
		settings: Type.Array(ConfigSettingSchema),
		/** Present when a settings file is invalid; its values are then not shown. */
		settingsErrors: Type.Optional(Type.Array(SettingsFileErrorSchema, { maxItems: 4 })),
		workspace: Type.Optional(ConfigWorkspaceSchema),
		/** True when this connection may change settings: the launch capability only, never a published link. */
		writable: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type ConfigSnapshot = Static<typeof ConfigSnapshotSchema>;

/** An address the page may show as a link. Only web links: the page never gets another scheme to open. */
const WebUrlSchema = Type.String({ pattern: "^https?://[^\\s\\u0000-\\u001f\\u007f]+$", maxLength: 2048 });
const SignInTextSchema = Type.String({ maxLength: 1000 });

/** What a running sign-in tells the page, in order. Mirrors the runtime's login events; none carries a credential. */
export const SignInEventSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("info"),
			message: SignInTextSchema,
			links: Type.Optional(
				Type.Array(
					Type.Object(
						{ url: WebUrlSchema, label: Type.Optional(Type.String({ maxLength: 200 })) },
						{ additionalProperties: false },
					),
					{ maxItems: 8 },
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("auth_url"), url: WebUrlSchema, instructions: Type.Optional(SignInTextSchema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("device_code"),
			userCode: Type.String({ minLength: 1, maxLength: 64 }),
			verificationUri: WebUrlSchema,
			expiresInSeconds: Type.Optional(Type.Number({ minimum: 0 })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("progress"), message: SignInTextSchema }, { additionalProperties: false }),
]);
export type SignInEvent = Static<typeof SignInEventSchema>;

/** A question the sign-in is waiting on. The page answers it with `action: "answer"` and this `id`. */
export const SignInPromptSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 64 }),
		type: StringEnum(["text", "secret", "select", "manual_code"] as const),
		message: SignInTextSchema,
		placeholder: Type.Optional(Type.String({ maxLength: 200 })),
		options: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: 200 }),
						label: Type.String({ maxLength: 200 }),
						description: Type.Optional(Type.String({ maxLength: 400 })),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 50 },
			),
		),
	},
	{ additionalProperties: false },
);
export type SignInPrompt = Static<typeof SignInPromptSchema>;

export const SIGN_IN_STATUSES = ["idle", "running", "succeeded", "failed", "cancelled"] as const;

/** `POST /api/admin/config/signin` replies with this. `error` is redacted fixed-length text, never a token. */
export const SignInStateSchema = Type.Object(
	{
		provider: ProviderIdSchema,
		status: StringEnum(SIGN_IN_STATUSES),
		events: Type.Array(SignInEventSchema, { maxItems: 32 }),
		prompt: Type.Optional(SignInPromptSchema),
		error: Type.Optional(Type.String({ maxLength: 500 })),
		/** True when the sign-in stored its credential but a later step failed: the page reads the snapshot again. */
		credentialSaved: Type.Optional(Type.Boolean()),
		/** When a running sign-in is abandoned by the host, in epoch milliseconds. */
		expiresAt: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type SignInState = Static<typeof SignInStateSchema>;

/**
 * `POST /api/admin/config/signin`: start, poll, answer or cancel the host-run OAuth sign-in of one provider. The host
 * runs the login; the page only shows its events and relays the user's answers (`value` may be a pasted code or a
 * secret, so it travels in this request body only). At most one sign-in runs per provider.
 */
export const SignInCommandSchema = Type.Union([
	Type.Object({ action: Type.Literal("start"), provider: ProviderIdSchema }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("status"), provider: ProviderIdSchema }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("cancel"), provider: ProviderIdSchema }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("answer"),
			provider: ProviderIdSchema,
			promptId: Type.String({ minLength: 1, maxLength: 64 }),
			value: Type.String({ maxLength: MAX_CREDENTIAL_KEY_LENGTH, pattern: "^[^\\u0000-\\u001f\\u007f]*$" }),
		},
		{ additionalProperties: false },
	),
]);
export type SignInCommand = Static<typeof SignInCommandSchema>;
