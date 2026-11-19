import { join } from "node:path";
import { getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { ModelConfig } from "../../core/model-config.ts";
import { applied, closestIds, nameOf, onlySwitch, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry } from "../types.ts";

/** Built-in providers, those models.json defines, and any already disabled: the ids the /providers page shows. */
async function knownProviders(ctx: ConfigContext, disabled: readonly string[]): Promise<string[]> {
	const custom = (await ModelConfig.load(join(ctx.agentDir, "models.json"))).getProviderIds();
	return [...new Set([...getBuiltinProviders(), ...custom, ...disabled])];
}

/** `provider:<id>`: the global `disabledProviders` list (a project file cannot hide a provider). */
export const providersAdapter: ConfigAdapter = {
	kinds: ["provider"],
	async list(ctx) {
		const disabled = new Set(ctx.settings.getDisabledProviders());
		const ids = (await knownProviders(ctx, [...disabled])).sort();
		return ids.map((id): ConfigEntry => ({
			id: `provider:${id}`,
			kind: "provider",
			label: id,
			valueType: { type: "toggle" },
			value: !disabled.has(id),
			scopes: disabled.has(id) ? { global: false } : {},
			setBy: disabled.has(id) ? "global" : "default",
			default: true,
			appliesWhen: "reload",
		}));
	},
	async apply(op, ctx) {
		const bad = onlySwitch(op);
		if (bad) return bad;
		if (op.scope && op.scope !== "global")
			return refused(op, "Providers switch globally only: a project file cannot hide a provider.");
		const id = nameOf(op.id);
		const disabled = ctx.settings.getDisabledProviders();
		const known = await knownProviders(ctx, disabled);
		if (!known.includes(id))
			return refused(
				op,
				`Unknown provider "${id}".`,
				closestIds(id, known).map((name) => `provider:${name}`),
			);
		const on = op.verb === "enable";
		ctx.settings.setDisabledProviders(on ? disabled.filter((name) => name !== id) : [...disabled, id]);
		await ctx.settings.flush();
		return applied(op, "reload", `Provider ${id} ${on ? "enabled" : "disabled"} globally.`);
	},
};
