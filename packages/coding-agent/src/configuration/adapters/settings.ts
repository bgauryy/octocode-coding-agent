import type { SettingsManager } from "../../core/settings-manager.ts";
import { applied, closestIds, kindOf, refused } from "../result.ts";
import { coerceSettingValue, findLeaf, OWNED_SETTINGS, type SettingLeaf, settingLeaves } from "../settings-leaves.ts";
import { type FileScope, nestPath, readPath, writeSettingsKey } from "../settings-write.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult, ConfigScope } from "../types.ts";

/**
 * Typed setters the manager already has, preferred over the generic write for the keys they own. `scope` is
 * only passed where the setter has a project form.
 */
type TypedSetter = (manager: SettingsManager, value: never, scope: FileScope) => void;
const TYPED_SETTERS: Readonly<Record<string, { set: TypedSetter; projectToo: boolean }>> = {
	defaultProvider: {
		set: (m, value: string, scope) => m.setDefaultSelection(scope, "defaultProvider", value),
		projectToo: true,
	},
	defaultModel: {
		set: (m, value: string, scope) => m.setDefaultSelection(scope, "defaultModel", value),
		projectToo: true,
	},
	defaultThinkingLevel: {
		set: (m, value: Parameters<SettingsManager["setDefaultThinkingLevel"]>[0]) => m.setDefaultThinkingLevel(value),
		projectToo: false,
	},
	steeringMode: { set: (m, value: "all" | "one-at-a-time") => m.setSteeringMode(value), projectToo: false },
	followUpMode: { set: (m, value: "all" | "one-at-a-time") => m.setFollowUpMode(value), projectToo: false },
	transport: {
		set: (m, value: Parameters<SettingsManager["setTransport"]>[0]) => m.setTransport(value),
		projectToo: false,
	},
	enableSkillCommands: { set: (m, value: boolean) => m.setEnableSkillCommands(value), projectToo: false },
};

function toEntry(leaf: SettingLeaf, ctx: ConfigContext): ConfigEntry {
	const global = readPath(ctx.settings.getGlobalSettings(), leaf.key);
	const project = ctx.projectTrusted ? readPath(ctx.settings.getProjectSettings(), leaf.key) : undefined;
	const effective = readPath(ctx.settings.getSettings(), leaf.key);
	const setBy = project !== undefined ? "project" : global !== undefined ? "global" : "default";
	return {
		id: leaf.key,
		kind: "setting",
		label: leaf.key,
		...(leaf.description ? { description: leaf.description } : {}),
		valueType: leaf.valueType,
		value: effective ?? leaf.default,
		scopes: {
			...(global !== undefined ? { global } : {}),
			...(project !== undefined ? { project } : {}),
		},
		setBy,
		...(leaf.default !== undefined ? { default: leaf.default } : {}),
		// Most keys are read when a session is created or reloaded; a few are read on every use, but the schema does not say which.
		appliesWhen: "reload",
	};
}

async function set(op: ConfigOp, leaf: SettingLeaf, value: unknown, ctx: ConfigContext): Promise<ConfigResult> {
	const scope: ConfigScope = op.scope ?? "global";
	if (scope === "run") {
		ctx.settings.applyOverrides(nestPath(leaf.key, value), { durable: true });
		return applied(op, "now", `${leaf.key} = ${JSON.stringify(value)} for this run only.`);
	}
	const typed = TYPED_SETTERS[leaf.key];
	if (typed && (scope === "global" || typed.projectToo)) {
		typed.set(ctx.settings, value as never, scope);
		await ctx.settings.flush();
	} else await writeSettingsKey(ctx, scope, leaf.key, value);
	const saved = `${leaf.key} = ${JSON.stringify(value)} saved ${scope === "project" ? "for this project" : "globally"}.`;
	// A session applies the keys its live settings list changes at once, through the same appliers.
	if (scope === "global" && ctx.live?.applySetting?.(leaf.key, value)) return applied(op, "now", saved);
	return applied(
		op,
		"reload",
		`${saved}${ctx.live?.applySetting ? ' The "Interface and session" list in /configuration applies the settings it shows at once.' : ""}`,
	);
}

export const settingsAdapter: ConfigAdapter = {
	kinds: ["setting"],
	async list(ctx) {
		const owned = new Set(Object.keys(OWNED_SETTINGS));
		return settingLeaves()
			.filter((leaf) => !owned.has(leaf.key))
			.map((leaf) => toEntry(leaf, ctx));
	},
	async apply(op, ctx) {
		if (kindOf(op.id) !== "setting") return refused(op, `${op.id} is not a settings key.`);
		const owner = OWNED_SETTINGS[op.id];
		if (owner) return refused(op, `${op.id} is changed through ${owner}, not as a settings key.`);
		const leaf = findLeaf(op.id);
		if (!leaf) {
			const keys = settingLeaves()
				.map((entry) => entry.key)
				.filter((key) => !(key in OWNED_SETTINGS));
			return refused(op, `Unknown settings key "${op.id}".`, closestIds(op.id, keys));
		}
		switch (op.verb) {
			case "enable":
			case "disable":
				if (leaf.valueType.type !== "boolean")
					return refused(op, `${leaf.key} is not a boolean (it takes ${leaf.valueType.type}); use set.`);
				return set(op, leaf, op.verb === "enable", ctx);
			case "set": {
				const coerced = coerceSettingValue(leaf, op.value);
				return coerced.ok ? set(op, leaf, coerced.value, ctx) : refused(op, coerced.reason);
			}
			case "unset":
				if (op.scope === "run") return refused(op, "A per-run setting cannot be unset: it lasts only this process.");
				await writeSettingsKey(ctx, op.scope ?? "global", leaf.key, undefined);
				return applied(op, "reload", `${leaf.key} removed from the ${op.scope ?? "global"} settings.`);
			default:
				return refused(op, `Settings keys take enable, disable, set and unset, not "${op.verb}".`);
		}
	},
};
