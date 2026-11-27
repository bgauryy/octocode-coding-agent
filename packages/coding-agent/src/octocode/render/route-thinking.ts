import { splitThinkingSuffix } from "../../core/model-reference.ts";
import { VALID_THINKING_LEVELS } from "../../core/thinking-level.ts";

/** The `:<level>` suffixes Octocode's `--model <pattern>` accepts. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set(VALID_THINKING_LEVELS);

/** The `:<level>` suffix a model value or purpose ends with (`:low`), or "" without one. */
export function thinkingSuffix(value: string | undefined): string {
	const split = value ? splitThinkingSuffix(value) : undefined;
	return value && split ? value.slice(split.base.length) : "";
}

/** A route's `:thinking` level (`low` in `p/m:low`), or undefined without one. */
export const routeThinking = (model: string | undefined): string | undefined =>
	thinkingSuffix(model).slice(1) || undefined;

/** The route with its level replaced by `level`. */
export const withThinking = (model: string, level: string): string =>
	`${model.slice(0, model.length - thinkingSuffix(model).length)}:${level}`;
