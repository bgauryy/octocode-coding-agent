import { globalOnlyRoot } from "../../core/settings-manager/global-only.ts";
import { ignoredSettingsKeys } from "../../core/settings-manager/ignored-keys.ts";
import { applied, closestIds, kindOf, refused } from "../result.ts";
import { coerceSettingValue, findLeaf, OWNED_SETTINGS, type SettingLeaf, settingLeaves } from "../settings-leaves.ts";
import { nestPath, readPath, writeSettingsKey } from "../settings-write.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry, ConfigOp, ConfigResult, ConfigScope } from "../types.ts";

const MODEL_DEFAULTS = new Set(["defaultProvider", "defaultModel"]);

function toEntry(leaf: SettingLeaf, ctx: ConfigContext): ConfigEntry {
	const global = readPath(ctx.settings.getGlobalSettings(), leaf.key);
	const project = ctx.projectTrusted ? readPath(ctx.settings.getProjectSettings(), leaf.key) : undefined;
	// A global-only key's readers open the global file themselves: what the project file holds never applies.
	const globalOnly = globalOnlyRoot(leaf.key) !== undefined;
	const effective = globalOnly ? global : readPath(ctx.settings.getSettings(), leaf.key);
	const setBy = project !== undefined && !globalOnly ? "project" : global !== undefined ? "global" : "default";
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
		...(globalOnly
			? {
					detail: `read from the global settings only; ${project === undefined ? "a project value is ignored" : `the project value ${JSON.stringify(project)} is ignored`}`,
				}
			: {}),
		// Model defaults choose new sessions; the running terminal applies its live keys at once; others are read on reload.
		appliesWhen: MODEL_DEFAULTS.has(leaf.key) ? "next-session" : ctx.live?.appliesLive?.(leaf.key) ? "now" : "reload",
	};
}

/** Why `scope` cannot hold a global-only key, or undefined when it can: its value there would do nothing. */
function globalOnlyRefusal(key: string, scope: ConfigScope): string | undefined {
	if (scope === "global" || globalOnlyRoot(key) === undefined) return undefined;
	const where = scope === "project" ? "a project value" : "a value for this run";
	return `${key} is read from the global settings only, so ${where} would do nothing. Set it in the global settings instead.`;
}

async function set(op: ConfigOp, leaf: SettingLeaf, value: unknown, ctx: ConfigContext): Promise<ConfigResult> {
	const scope: ConfigScope = op.scope ?? "global";
	const globalOnly = globalOnlyRefusal(leaf.key, scope);
	if (globalOnly) return refused(op, globalOnly);
	if (scope === "run") {
		ctx.settings.applyOverrides(nestPath(leaf.key, value), { durable: true });
		const message = `${leaf.key} = ${JSON.stringify(value)} for this run only.`;
		return MODEL_DEFAULTS.has(leaf.key)
			? applied(op, "next-session", `${message} New sessions use this default; the current chat keeps its model.`)
			: applied(op, "now", message);
	}
	await writeSettingsKey(ctx, scope, leaf.key, value);
	const saved = `${leaf.key} = ${JSON.stringify(value)} saved ${scope === "project" ? "for this project" : "globally"}.`;
	if (MODEL_DEFAULTS.has(leaf.key))
		return applied(op, "next-session", `${saved} New sessions use this default; the current chat keeps its model.`);
	// A session applies the keys its live settings list changes at once, from the files as they now are.
	if (ctx.live?.applySetting?.(leaf.key)) return applied(op, "now", saved);
	return applied(
		op,
		"reload",
		`${saved}${ctx.live?.applySetting ? ' The "Interface and session" list in /settings applies the settings it shows at once.' : ""}`,
	);
}

/** True when `unset` names a key the settings file holds but Octocode ignores: the one-step fix for the startup warning. */
function isIgnoredKey(op: ConfigOp, ctx: ConfigContext): boolean {
	if (op.scope === "run") return false;
	const file = op.scope === "project" ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings();
	return ignoredSettingsKeys(file).includes(op.id);
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
		if (!leaf && op.verb === "unset" && isIgnoredKey(op, ctx)) {
			await writeSettingsKey(ctx, op.scope === "project" ? "project" : "global", op.id, undefined);
			return applied(op, "reload", `${op.id} removed from the ${op.scope ?? "global"} settings.`);
		}
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
				return applied(
					op,
					MODEL_DEFAULTS.has(leaf.key)
						? "next-session"
						: // The running terminal takes the value that applies now (another scope's, or the default).
							ctx.live?.applySetting?.(leaf.key)
							? "now"
							: "reload",
					`${leaf.key} removed from the ${op.scope ?? "global"} settings.`,
				);
			default:
				return refused(op, `Settings keys take enable, disable, set and unset, not "${op.verb}".`);
		}
	},
};
