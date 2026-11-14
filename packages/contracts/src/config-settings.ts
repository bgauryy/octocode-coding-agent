import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";

export const CONFIG_SETTING_KEYS = ["defaultProvider", "defaultModel"] as const;
export const ConfigSettingKeySchema = StringEnum(CONFIG_SETTING_KEYS);
export type ConfigSettingKey = Static<typeof ConfigSettingKeySchema>;
export const CONFIG_SETTING_SCOPES = ["global", "workspace"] as const;
export const ConfigSettingScopeSchema = StringEnum(CONFIG_SETTING_SCOPES);
export type ConfigSettingScope = Static<typeof ConfigSettingScopeSchema>;

const ValueSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const Target = { scope: ConfigSettingScopeSchema, repoId: Type.Optional(Type.String({ pattern: "^[\\w.-]{1,128}$" })) };

/** Legacy single-field writes remain valid; the UI replaces or clears a startup provider/model pair atomically. */
export const ConfigSettingCommandSchema = Type.Union([
	Type.Object(
		{ key: ConfigSettingKeySchema, value: Type.Union([ValueSchema, Type.Null()]), ...Target },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			key: Type.Literal("modelDefault"),
			value: Type.Union([
				Type.Object({ provider: ValueSchema, model: ValueSchema }, { additionalProperties: false }),
				Type.Null(),
			]),
			...Target,
		},
		{ additionalProperties: false },
	),
]);
export type ConfigSettingCommand = Static<typeof ConfigSettingCommandSchema>;
