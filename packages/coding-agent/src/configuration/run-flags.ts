import { createConfiguration } from "./index.ts";
import { formatResult } from "./command.ts";
import type { ConfigContext, ConfigOp, ConfigRefused } from "./types.ts";

/** `--enable <id>`, `--disable <id>` and `--set <key>=<value>` as the CLI parser collects them. */
export interface RunConfigFlags {
	enable?: string[];
	disable?: string[];
	set?: string[];
}

export const hasRunFlags = (flags: RunConfigFlags): boolean =>
	[flags.enable, flags.disable, flags.set].some((list) => (list?.length ?? 0) > 0);

/** The flags as catalog operations at run scope. */
function runFlagOps(flags: RunConfigFlags): ConfigOp[] {
	return [
		...(flags.enable ?? []).map((id): ConfigOp => ({ verb: "enable", id, scope: "run" })),
		...(flags.disable ?? []).map((id): ConfigOp => ({ verb: "disable", id, scope: "run" })),
		...(flags.set ?? []).map((word): ConfigOp => {
			const equals = word.indexOf("=");
			return { verb: "set", id: word.slice(0, equals), value: word.slice(equals + 1), scope: "run" };
		}),
	];
}

/**
 * Applies the per-run flags to `ctx.settings` in memory (nothing is written). Returns every refusal; the caller prints
 * them and stops, so a flag is never silently ignored.
 */
export async function applyRunFlags(flags: RunConfigFlags, ctx: ConfigContext): Promise<ConfigRefused[]> {
	const catalog = createConfiguration(ctx);
	const refused: ConfigRefused[] = [];
	for (const op of runFlagOps(flags)) {
		const result = await catalog.apply(op);
		if (result.status === "refused") refused.push(result);
	}
	return refused;
}

/** The refusals as the lines to print, one flag form each. */
export function runFlagErrors(refused: readonly ConfigRefused[]): string[] {
	return refused.flatMap((result) => {
		const flag = result.verb === "set" ? "--set" : `--${result.verb}`;
		return formatResult(result).map((line, index) => (index === 0 ? `${flag} ${result.id}: ${result.reason}` : line));
	});
}
