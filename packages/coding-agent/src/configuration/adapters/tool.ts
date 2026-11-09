import { MCP_MANAGE_TOOL_NAME } from "../../../../mcp/src/servers.ts";
import { isToolModifier, resolveDefaultTools } from "../../core/settings-manager/tool-list.ts";
import { getNativeToolNames } from "../../octocode/permission/native-tools.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { applied, closestIds, nameOf, onlySwitch, refused } from "../result.ts";
import { nestPath, writeSettingsKey } from "../settings-write.ts";
import type { ConfigAdapter, ConfigContext, ConfigEntry } from "../types.ts";

/**
 * Tools that exist without a session: the native tools (declared in `octocode/permission/native-tools.ts`) and the `mcp`
 * tool. Tools an extension or MCP server adds exist only in a running session; the ones named in settings are listed too.
 */
function knownTools(lists: readonly (readonly unknown[] | undefined)[]): string[] {
	const named = lists.flatMap((list) =>
		(list ?? []).flatMap((entry) =>
			typeof entry === "string"
				? [isToolModifier(entry) ? entry.slice(1) : entry].filter((name) => name && !name.includes("*"))
				: [],
		),
	);
	return [...new Set([...getNativeToolNames(), MCP_MANAGE_TOOL_NAME, ...named])].sort();
}

const defaultsOf = () => [...getNativeToolNames(), MCP_MANAGE_TOOL_NAME];

const listOf = (settings: Settings): string[] | undefined =>
	Array.isArray(settings.defaultTools) ? settings.defaultTools.filter((tool) => typeof tool === "string") : undefined;

/**
 * `defaultTools` after switching `name`: a list of plain names (an allowlist) gains or loses the name; a list of `+name` and
 * `-name` entries (or none) replaces that tool's entry, keeping the others.
 */
function withToolSwitched(list: readonly string[] | undefined, name: string, on: boolean): string[] {
	const current = list ?? [];
	if (current.some((entry) => !isToolModifier(entry)))
		return on
			? current.includes(name)
				? [...current]
				: [...current, name]
			: current.filter((entry) => entry !== name);
	return [...current.filter((entry) => entry.slice(1) !== name), `${on ? "+" : "-"}${name}`];
}

export const toolAdapter: ConfigAdapter = {
	kinds: ["tool"],
	async list(ctx: ConfigContext) {
		const global = listOf(ctx.settings.getGlobalSettings());
		const project = ctx.projectTrusted ? listOf(ctx.settings.getProjectSettings()) : undefined;
		const effective = listOf(ctx.settings.getSettings());
		const on = (list: string[] | undefined, name: string) =>
			list ? resolveDefaultTools(list, defaultsOf()).includes(name) : undefined;
		return knownTools([global, project, effective]).map((name): ConfigEntry => {
			const [g, p] = [on(global, name), on(project, name)];
			return {
				id: `tool:${name}`,
				kind: "tool",
				label: name,
				valueType: { type: "toggle" },
				value: on(effective, name) ?? true,
				scopes: { ...(g === undefined ? {} : { global: g }), ...(p === undefined ? {} : { project: p }) },
				setBy: p !== undefined ? "project" : g !== undefined ? "global" : "default",
				default: true,
				// The tool set is chosen when a session is created.
				appliesWhen: "next-session",
			};
		});
	},
	async apply(op, ctx) {
		const bad = onlySwitch(op);
		if (bad) return bad;
		const name = nameOf(op.id);
		const scope = op.scope ?? "global";
		const base =
			scope === "run"
				? listOf(ctx.settings.getSettings())
				: listOf(scope === "project" ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings());
		const known = knownTools([base]);
		if (!known.includes(name))
			return refused(
				op,
				`Unknown tool "${name}".`,
				closestIds(
					op.id,
					known.map((tool) => `tool:${tool}`),
				),
			);
		const next = withToolSwitched(base, name, op.verb === "enable");
		if (scope === "run") ctx.settings.applyOverrides(nestPath("defaultTools", next), { durable: true });
		else await writeSettingsKey(ctx, scope, "defaultTools", next);
		return applied(op, "next-session", `${op.id} ${op.verb}d (${scope}); defaultTools: ${JSON.stringify(next)}.`);
	},
};
