import { describeProviderSources } from "../../core/provider-sources/registry.ts";
import { TOGGLEABLE_SOURCE_IDS, type ToggleableSourceId } from "../../core/provider-sources/types.ts";
import { applied, closestIds, nameOf, onlySwitch, refused } from "../result.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry } from "../types.ts";

const describe = (ctx: ConfigContext) =>
	describeProviderSources(ctx.settings.getGlobalSettings().providerSources, {
		agentDir: ctx.agentDir,
		...(ctx.home ? { home: ctx.home } : {}),
	});

/** `source:<id>`: where credentials and models are read from (Pi's files, Copilot's variable); global `providerSources`. */
export const sourcesAdapter: ConfigAdapter = {
	kinds: ["source"],
	async list(ctx) {
		return describe(ctx).map((source): ConfigEntry => ({
			id: `source:${source.id}`,
			kind: "source",
			label: source.label,
			valueType: { type: "toggle" },
			value: source.state.enabled,
			scopes: source.state.overridden ? { global: source.state.enabled } : {},
			setBy: source.state.overridden ? "global" : "default",
			default: source.defaultEnabled,
			appliesWhen: "reload",
			detail: source.paths.join(", "),
			...(source.toggleable ? {} : { locked: "always on" }),
		}));
	},
	async apply(op, ctx) {
		const bad = onlySwitch(op);
		if (bad) return bad;
		if (op.scope && op.scope !== "global")
			return refused(op, "Sources switch globally only: a project file cannot turn a source on.");
		const id = nameOf(op.id);
		if (!(TOGGLEABLE_SOURCE_IDS as readonly string[]).includes(id)) {
			const known = describe(ctx).map((source) => `source:${source.id}`);
			return refused(
				op,
				known.includes(op.id) ? `Source ${id} is always on.` : `Unknown source "${id}".`,
				known.includes(op.id) ? undefined : closestIds(op.id, known),
			);
		}
		const on = op.verb === "enable";
		ctx.settings.setProviderSourceEnabled(id as ToggleableSourceId, on);
		await ctx.settings.flush();
		return applied(op, "reload", `Source ${id} ${on ? "enabled" : "disabled"} globally.`);
	},
};
