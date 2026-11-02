import type { ConfigItem, ConfigKind, ConfigScope, Product } from "./types.ts";

/**
 * How items of a kind compete:
 * - `collection`: items share a name; scope decides, then product.
 * - `single`: one value for the whole kind; product decides, then scope.
 * - `additive`: every item applies; nothing is shadowed.
 * - `layered`: every file applies and its keys merge, product first then scope; nothing is shadowed as a file (a key is
 *   shadowed, which a loader decides while it merges).
 */
type KindRule = "collection" | "single" | "additive" | "layered";

const RULES: Record<ConfigKind, KindRule> = {
	skill: "collection",
	prompt: "collection",
	theme: "collection",
	agent: "collection",
	mcp: "collection",
	context: "single",
	systemPrompt: "single",
	appendSystemPrompt: "single",
	model: "layered",
	setting: "layered",
	keybinding: "additive",
	extension: "additive",
	hook: "additive",
	plugin: "additive",
};

const SCOPE_RANK: Record<ConfigScope, number> = { project: 0, global: 1, builtin: 2 };
const PRODUCT_RANK: Record<Product, number> = { octocode: 0, pi: 1 };
/** A user copy another tool installed (`~/.agents`, Pi's folders) ranks below the skills bundled with this build, and a plugin's agent (origin `plugin:<name>`) below every profile. */
const REPLACEABLE_RANK = 3;

function scopeRank(item: ConfigItem): number {
	const { scope, origin } = item.provenance;
	if (item.kind === "skill" && scope === "global" && origin !== "octocode" && origin !== "plugin")
		return REPLACEABLE_RANK;
	if (item.kind === "agent" && origin.startsWith("plugin:")) return REPLACEABLE_RANK;
	return SCOPE_RANK[scope];
}

function compare(rule: KindRule, a: ConfigItem, b: ConfigItem): number {
	const product = PRODUCT_RANK[a.provenance.product] - PRODUCT_RANK[b.provenance.product];
	const scope = scopeRank(a) - scopeRank(b);
	return rule === "single" || rule === "layered" ? product || scope : scope || product;
}

/**
 * Order `items` by precedence (the sort is stable, so a source's own order breaks ties) and mark every item that loses to
 * another of the same kind and name `loaded: false` with `shadowedBy`. Items that are not loaded never win.
 */
export function applyPrecedence(kind: ConfigKind, items: readonly ConfigItem[]): ConfigItem[] {
	const rule = RULES[kind];
	const ordered = [...items];
	if (rule === "additive")
		return ordered.map((item) => ({ ...item, loaded: item.loaded && !item.provenance.notLoaded }));
	ordered.sort((a, b) => compare(rule, a, b));
	if (rule === "layered")
		return ordered.map((item) => ({ ...item, loaded: item.loaded && !item.provenance.notLoaded }));
	const winners = new Map<string, ConfigItem>();
	return ordered.map((item) => {
		// A source may hand over an item it already knows is unusable (a file that does not parse): it never wins.
		if (item.provenance.notLoaded || !item.loaded) return { ...item, loaded: false };
		// A control-only override competes only with other overrides of the same name: the highest one wins.
		const key = rule === "single" ? "" : item.role === "override" ? `${item.name}\0override` : item.name;
		const winner = winners.get(key);
		if (!winner) {
			winners.set(key, item);
			return { ...item, loaded: true };
		}
		const { shadowedBy: _ignored, notLoaded: _unused, ...shadowing } = winner.provenance;
		return { ...item, loaded: false, provenance: { ...item.provenance, shadowedBy: shadowing } };
	});
}
