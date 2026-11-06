import type { ConfigItem, ConfigKind, ConfigScope, ItemVendor, Product } from "./types.ts";

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
	memory: "additive",
};

const SCOPE_RANK: Record<ConfigScope, number> = { project: 0, global: 1, builtin: 2 };
const PRODUCT_RANK: Record<Product, number> = { octocode: 0, pi: 1 };
/** A user copy another tool installed (`~/.agents`, Pi's folders) ranks below every other scope, and a plugin's agent (origin `plugin:<name>`) below every profile. */
const REPLACEABLE_RANK = 3;

function scopeRank(item: ConfigItem): number {
	const { scope, origin } = item.provenance;
	if (item.kind === "skill" && scope === "global" && origin !== "octocode" && origin !== "plugin")
		return REPLACEABLE_RANK;
	if (item.kind === "agent" && origin.startsWith("plugin:")) return REPLACEABLE_RANK;
	return SCOPE_RANK[scope];
}

/** Skills of the same name from several harnesses: the earlier harness wins (the user's decision), project before global within one. */
const VENDOR_RANK: Record<ItemVendor, number> = {
	octocode: 0,
	agents: 1,
	"mcp-json": 2,
	pi: 3,
	claude: 4,
	codex: 5,
	cursor: 6,
};

/** Another agent's MCP file: its server never replaces one of the same name from an Octocode-format file, in any scope (the loader's rule). */
const FOREIGN_MCP_VENDORS: ReadonlySet<ItemVendor> = new Set(["claude", "codex", "cursor"]);
const foreignMcp = (item: ConfigItem): number => Number(FOREIGN_MCP_VENDORS.has(item.provenance.vendor));

function compare(rule: KindRule, a: ConfigItem, b: ConfigItem): number {
	if (a.kind === "mcp") {
		const foreign = foreignMcp(a) - foreignMcp(b);
		if (foreign) return foreign;
	}
	if (a.kind === "skill")
		return VENDOR_RANK[a.provenance.vendor] - VENDOR_RANK[b.provenance.vendor] || scopeRank(a) - scopeRank(b);
	const product = PRODUCT_RANK[a.provenance.product] - PRODUCT_RANK[b.provenance.product];
	const scope = scopeRank(a) - scopeRank(b);
	return rule === "single" || rule === "layered" ? product || scope : scope || product;
}

/** Hook files load in the documented order (docs/hooks.md): user files before project files, and within a scope Claude, Codex, then Octocode. */
const HOOK_VENDOR_RANK: Partial<Record<ItemVendor, number>> = { claude: 0, codex: 1, octocode: 2 };
const HOOK_SCOPE_RANK: Record<ConfigScope, number> = { global: 0, project: 1, builtin: 2 };
const hookVendorRank = (item: ConfigItem): number => HOOK_VENDOR_RANK[item.provenance.vendor] ?? 3;

function compareHooks(a: ConfigItem, b: ConfigItem): number {
	return (
		HOOK_SCOPE_RANK[a.provenance.scope] - HOOK_SCOPE_RANK[b.provenance.scope] || hookVendorRank(a) - hookVendorRank(b)
	);
}

/**
 * Order `items` by precedence (the sort is stable, so a source's own order breaks ties) and mark every item that loses to
 * another of the same kind and name `loaded: false` with `shadowedBy`. Items that are not loaded never win.
 */
export function applyPrecedence(kind: ConfigKind, items: readonly ConfigItem[]): ConfigItem[] {
	const rule = RULES[kind];
	const ordered = [...items];
	if (kind === "hook") ordered.sort(compareHooks);
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
