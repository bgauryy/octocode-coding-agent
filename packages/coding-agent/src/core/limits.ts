import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The `limits` settings resolved for one model. A consumer keeps its own built-in constant and reads the override here:
 * an absent or invalid value is undefined, so the built-in applies. Lookup is a handful of key reads per request.
 */

export interface ResolvedLimits {
	compaction: { trigger?: number; keepRecent?: number };
	clearing: { keepTurns?: number; keepInUseTokens?: number };
	loop?: { noteAt: number; stopAt: number; haltAt: number };
	run: { maxRequests?: number };
	subagent: { maxRequests?: number };
	cost: { max?: number; warnAt?: number };
}

/**
 * The groups that bound what a session may request or spend. They are read from the global settings file only
 * (`GLOBAL_ONLY_SETTINGS`), under `limits.models` too: a repository cannot raise its own budget.
 */
const GLOBAL_ONLY_LIMITS: readonly string[] = ["run", "subagent", "cost"];

/** `limits` without the global-only groups, as a project file's block is merged; undefined when nothing is left. */
export function projectLimits(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const strip = (block: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(block).filter(([key]) => !GLOBAL_ONLY_LIMITS.includes(key)));
	const kept = strip(value);
	if (isRecord(value.models))
		kept.models = Object.fromEntries(
			Object.entries(value.models).map(([key, block]) => [key, isRecord(block) ? strip(block) : block]),
		);
	return kept;
}

type Check = (value: unknown) => boolean;
const positive: Check = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const count =
	(minimum: number): Check =>
	(value) =>
		Number.isSafeInteger(value) && (value as number) >= minimum;

/** Every per-model key: its check and the sentence a bad value earns. */
const FIELDS: Record<string, Record<string, { ok: Check; rule: string }>> = {
	compaction: {
		trigger: {
			ok: (value) => positive(value) && ((value as number) > 1 || (value as number) >= 0.1),
			rule: "a share of the window from 0.1 to 1, or a token count above 1",
		},
		keepRecent: {
			ok: (value) => positive(value) && ((value as number) > 1 || (value as number) <= 0.25),
			rule: "a share of the window up to 0.25, or a token count above 1",
		},
	},
	clearing: {
		keepTurns: { ok: count(1), rule: "a whole number of 1 or more" },
		keepInUseTokens: { ok: count(0), rule: "a whole number of 0 or more" },
	},
	run: { maxRequests: { ok: count(0), rule: "a whole number of 0 or more" } },
	subagent: { maxRequests: { ok: count(0), rule: "a whole number of 0 or more" } },
	loop: {
		noteAt: { ok: count(2), rule: "a whole number of 2 or more" },
		stopAt: { ok: count(3), rule: "a whole number of 3 or more" },
		haltAt: { ok: count(4), rule: "a whole number of 4 or more" },
	},
};
const COST: Record<string, { ok: Check; rule: string }> = {
	max: { ok: positive, rule: "a number above 0" },
	warnAt: { ok: positive, rule: "a number above 0" },
};

const LOOP_ORDER = "noteAt, stopAt and haltAt must rise in that order";
const rising = (loop: Record<string, unknown>, built: readonly [number, number, number]): boolean => {
	const [note, stop, halt] = (["noteAt", "stopAt", "haltAt"] as const).map((key, at) =>
		FIELDS.loop[key].ok(loop[key]) ? (loop[key] as number) : built[at],
	);
	return note < stop && stop < halt;
};

/** The built-in repeated-call counts, which a partial `loop` block is completed from (`octocode/loop-guard.ts`). */
const LOOP_DEFAULTS = [3, 5, 8] as const;

function groupProblems(
	group: unknown,
	fields: Record<string, { ok: Check; rule: string }>,
	path: string,
	problems: string[],
): void {
	if (group === undefined) return;
	if (!isRecord(group)) {
		problems.push(`Setting "${path}" must be an object, so it does nothing.`);
		return;
	}
	for (const [key, value] of Object.entries(group)) {
		const field = fields[key];
		if (!field) problems.push(`Setting "${path}.${key}" is not a known setting, so it does nothing.`);
		else if (value !== undefined && !field.ok(value))
			problems.push(`Setting "${path}.${key}" must be ${field.rule}; the built-in value applies.`);
	}
}

function blockProblems(block: Record<string, unknown>, path: string, extra: readonly string[], out: string[]): void {
	for (const key of Object.keys(block)) {
		if (!(key in FIELDS) && !extra.includes(key))
			out.push(`Setting "${path}.${key}" is not a known setting, so it does nothing.`);
	}
	for (const [name, fields] of Object.entries(FIELDS)) groupProblems(block[name], fields, `${path}.${name}`, out);
	if (isRecord(block.loop) && !rising(block.loop, LOOP_DEFAULTS))
		out.push(`Setting "${path}.loop": ${LOOP_ORDER}; the built-in counts apply.`);
}

/**
 * What is wrong with a settings file's `limits` value, one sentence each (none when it is absent or valid). The
 * settings loader queues these as warnings; `resolveLimits` skips each bad value, so the built-in applies to it alone.
 */
export function limitsProblems(value: unknown, scope: "global" | "project" = "global"): string[] {
	if (value === undefined) return [];
	if (!isRecord(value)) return ['Setting "limits" must be an object, so it does nothing.'];
	const problems: string[] = [];
	if (scope === "project" && isRecord(value.models))
		for (const [key, block] of Object.entries(value.models))
			for (const group of GLOBAL_ONLY_LIMITS)
				if (isRecord(block) && block[group] !== undefined)
					problems.push(
						`Setting "limits.models.${key}.${group}" is global only; a project settings file cannot set it, so it does nothing.`,
					);
	blockProblems(value, "limits", ["cost", "models"], problems);
	groupProblems(value.cost, COST, "limits.cost", problems);
	if (value.models !== undefined && !isRecord(value.models))
		problems.push('Setting "limits.models" must be an object keyed by `provider/model`, so it does nothing.');
	else if (isRecord(value.models))
		for (const [key, block] of Object.entries(value.models)) {
			if (isRecord(block)) blockProblems(block, `limits.models.${key}`, [], problems);
			else problems.push(`Setting "limits.models.${key}" must be an object, so it does nothing.`);
		}
	return problems;
}

/** Whether `pattern` (`*` matches any run of characters) names `key`, ignoring case. */
function matches(pattern: string, key: string): boolean {
	const parts = pattern.toLowerCase().split("*");
	const text = key.toLowerCase();
	if (parts.length === 1) return parts[0] === text;
	if (!text.startsWith(parts[0])) return false;
	let at = parts[0].length;
	for (const part of parts.slice(1, -1)) {
		const found = text.indexOf(part, at);
		if (found < 0) return false;
		at = found + part.length;
	}
	const last = parts[parts.length - 1];
	return text.length - at >= last.length && text.endsWith(last);
}

/** The `models` blocks naming `modelKey`, least specific first: patterns by length, then the exact key. */
function modelBlocks(models: unknown, modelKey: string | undefined): Record<string, unknown>[] {
	if (!isRecord(models) || !modelKey) return [];
	return Object.keys(models)
		.filter((pattern) => isRecord(models[pattern]) && matches(pattern, modelKey))
		.sort((a, b) => Number(!a.includes("*")) - Number(!b.includes("*")) || a.length - b.length)
		.map((pattern) => models[pattern] as Record<string, unknown>);
}

/** The valid value of `group.key` in the last layer that sets one. */
function pick(layers: readonly Record<string, unknown>[], group: string, key: string): number | undefined {
	for (let at = layers.length - 1; at >= 0; at--) {
		const value = isRecord(layers[at][group]) ? (layers[at][group] as Record<string, unknown>)[key] : undefined;
		if (value !== undefined && (FIELDS[group] ?? COST)[key].ok(value)) return value as number;
	}
	return undefined;
}

const layersOf = (limits: unknown, modelKey: string | undefined): Record<string, unknown>[] =>
	isRecord(limits) ? [limits, ...modelBlocks(limits.models, modelKey)] : [];

/**
 * The limits in force for `modelKey` (`provider/model`): the effective `limits` block (`Settings.limits`), under the
 * `models` entries that name the model.
 */
export function resolveLimits(limits: unknown, modelKey?: string): ResolvedLimits {
	const all = layersOf(limits, modelKey);
	const defined = <T extends object>(value: T): T =>
		Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as T;
	const loop = [pick(all, "loop", "noteAt"), pick(all, "loop", "stopAt"), pick(all, "loop", "haltAt")];
	const counts = loop.map((value, at) => value ?? LOOP_DEFAULTS[at]);
	const custom = loop.some((value) => value !== undefined) && counts[0] < counts[1] && counts[1] < counts[2];
	return {
		compaction: defined({
			trigger: pick(all, "compaction", "trigger"),
			keepRecent: pick(all, "compaction", "keepRecent"),
		}),
		clearing: defined({
			keepTurns: pick(all, "clearing", "keepTurns"),
			keepInUseTokens: pick(all, "clearing", "keepInUseTokens"),
		}),
		...(custom ? { loop: { noteAt: counts[0], stopAt: counts[1], haltAt: counts[2] } } : {}),
		run: defined({ maxRequests: pick(all, "run", "maxRequests") }),
		subagent: defined({ maxRequests: pick(all, "subagent", "maxRequests") }),
		// Spend is the session's, whatever model runs: a `models` entry cannot name it.
		cost: defined({ max: pick(all.slice(0, 1), "cost", "max"), warnAt: pick(all.slice(0, 1), "cost", "warnAt") }),
	};
}

/** `provider/model`, the key `limits.models` is matched against; undefined without a model. */
export const limitsModelKey = (model?: { provider?: string; id?: string }): string | undefined =>
	model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;

/** `value` as tokens of `window`: a share of it at 1 or below, a token count above. */
export const tokensOfWindow = (value: number, window: number): number =>
	Math.floor(value <= 1 ? value * window : value);
