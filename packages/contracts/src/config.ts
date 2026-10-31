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
		sources: Type.Array(CredentialSourceStatusSchema, { maxItems: 16 }),
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

/** The read-only configuration page's model. It never carries a secret, a key value or `!` reference text. */
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
	},
	{ additionalProperties: false },
);
export type ConfigSnapshot = Static<typeof ConfigSnapshotSchema>;
