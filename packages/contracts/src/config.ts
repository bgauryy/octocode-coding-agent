import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

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
	},
	{ additionalProperties: false },
);
export type ProviderCredentialStatus = Static<typeof ProviderCredentialStatusSchema>;

/** The settings the page shows and may change, in page order. Each is a string; a workspace value replaces the global one. */
export const CONFIG_SETTING_KEYS = ["defaultProvider", "defaultModel"] as const;
export const ConfigSettingKeySchema = StringEnum(CONFIG_SETTING_KEYS);
export type ConfigSettingKey = Static<typeof ConfigSettingKeySchema>;

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

/** The files a setting can be written to. `default` is a source, never a target. */
export const CONFIG_SETTING_SCOPES = ["global", "workspace"] as const;
export const ConfigSettingScopeSchema = StringEnum(CONFIG_SETTING_SCOPES);
export type ConfigSettingScope = Static<typeof ConfigSettingScopeSchema>;

/**
 * `POST /api/admin/config/settings`: set or clear one allow-listed setting in one file. `value: null` removes the key
 * from that file, so the other scope (or the default) applies again. A `workspace` write names the repository the
 * daemon indexed (`repoId`, never a path) and needs the workspace to be trusted.
 */
export const ConfigSettingCommandSchema = Type.Object(
	{
		key: ConfigSettingKeySchema,
		scope: ConfigSettingScopeSchema,
		/** No control characters, so a value cannot break a line of a log or a settings file. */
		value: Type.Union([
			Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
			Type.Null(),
		]),
		repoId: Type.Optional(Type.String({ pattern: "^[\\w.-]{1,128}$" })),
	},
	{ additionalProperties: false },
);
export type ConfigSettingCommand = Static<typeof ConfigSettingCommandSchema>;

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
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("clear"), provider: ProviderIdSchema }, { additionalProperties: false }),
]);
export type ConfigCredentialCommand = Static<typeof ConfigCredentialCommandSchema>;

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
