import { closestIds, kindOf, refused } from "./result.ts";
import type {
	ConfigAdapter,
	ConfigContext,
	ConfigEntry,
	ConfigFilter,
	ConfigOp,
	ConfigResult,
	ConfigVerb,
} from "./types.ts";

export interface ConfigCatalog {
	/** Every entry the adapters list, narrowed by `filter`, ordered by kind then id. */
	list(filter?: ConfigFilter): Promise<ConfigEntry[]>;
	/** One entry by exact id, or undefined. */
	get(id: string): Promise<ConfigEntry | undefined>;
	/** Runs one write verb. Never throws for a refusal: the result says why. */
	apply(op: ConfigOp): Promise<ConfigResult>;
	/**
	 * What a batch of writes needs once, after the last one: a harness switch changes which MCP servers its files supply,
	 * so a running session reloads the MCP owner (one reload per command). Returns lines to print.
	 */
	settle(results: readonly ConfigResult[]): Promise<string[]>;
	/** The kinds that exist, for completion and help. */
	kinds(): string[];
}

const NO_RUN_FORM: readonly ConfigVerb[] = ["add", "remove"];

/**
 * The registry that routes configuration by id kind. It checks what is the same for every owner (the id has an owner,
 * project scope needs a trusted folder, `add`/`remove` have no in-memory form); each adapter checks what is its own.
 */
export function createConfigCatalog(ctx: ConfigContext, adapters: readonly ConfigAdapter[]): ConfigCatalog {
	const owner = (kind: string) => adapters.find((adapter) => adapter.kinds.includes(kind));

	async function list(filter: ConfigFilter = {}): Promise<ConfigEntry[]> {
		const wanted = filter.kinds?.length ? new Set(filter.kinds) : undefined;
		const chosen = adapters.filter((adapter) => !wanted || adapter.kinds.some((kind) => wanted.has(kind)));
		const text = filter.text?.trim().toLowerCase();
		const entries = (await Promise.all(chosen.map((adapter) => adapter.list(ctx)))).flat();
		return entries
			.filter((entry) => !wanted || wanted.has(entry.kind))
			.filter(
				(entry) =>
					!text || [entry.id, entry.label, entry.description ?? ""].some((field) => field.toLowerCase().includes(text)),
			)
			.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
	}

	return {
		list,
		kinds: () => [...new Set(adapters.flatMap((adapter) => adapter.kinds))],
		async get(id) {
			const adapter = owner(kindOf(id));
			return adapter ? (await adapter.list(ctx)).find((entry) => entry.id === id) : undefined;
		},
		async settle(results) {
			const switched = results.some((result) => result.status === "applied" && kindOf(result.id) === "harness");
			if (!switched || !ctx.live?.mcpReload) return [];
			try {
				const reloaded = await ctx.live.mcpReload();
				if (!reloaded) return [];
				const changed = [...new Set([...reloaded.added, ...reloaded.removed])];
				return [
					changed.length
						? `MCP servers applied now: ${changed.join(", ")} (connected or closed without a reload).`
						: "MCP servers checked: no change (applies now).",
				];
			} catch (error) {
				return [
					`The switches are saved, but the MCP reload failed (${error instanceof Error ? error.message : String(error)}); run /reload.`,
				];
			}
		},
		async apply(op) {
			const scope = op.scope ?? "global";
			if (scope === "project" && !ctx.projectTrusted)
				return refused(
					op,
					"This folder is not trusted, so project configuration is refused. Trust it first (/trust, or `octocode trust add`).",
				);
			if (scope === "run" && NO_RUN_FORM.includes(op.verb))
				return refused(op, `"${op.verb}" has no per-run form: it changes a file. Use global or project scope.`);
			const adapter = owner(kindOf(op.id));
			if (!adapter) {
				const all = (await list()).map((entry) => entry.id);
				return refused(op, `Unknown id "${op.id}": nothing owns the kind "${kindOf(op.id)}".`, closestIds(op.id, all));
			}
			return adapter.apply(op, ctx);
		},
	};
}
