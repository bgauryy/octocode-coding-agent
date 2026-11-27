import { stripBom } from "@octocodeai/octocode-common/text";
import type { Settings } from "../core/settings-schema.ts";
import type { ConfigContext } from "./types.ts";

export type FileScope = "global" | "project";

/** The value at a dotted path of a settings object, or undefined. */
export function readPath(settings: unknown, key: string): unknown {
	let node = settings;
	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `a.b.c = 1` as `{ a: { b: { c: 1 } } }`: the form `SettingsManager.applyOverrides` takes. */
export function nestPath(key: string, value: unknown): Partial<Settings> {
	return key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as Partial<Settings>;
}

/**
 * Write one dotted key of a scope's settings file, keeping every other key, through the manager's own storage
 * (`rewriteScope`: same file, lock and atomic write; memory for an in-memory manager), which then reloads, so the change
 * is read back. `undefined` removes the key and any section left empty. Throws when the file does not parse.
 */
export async function writeSettingsKey(
	ctx: ConfigContext,
	scope: FileScope,
	key: string,
	value: unknown,
): Promise<void> {
	await updateSettingsKey(ctx, scope, key, () => value);
}

/**
 * `writeSettingsKey` for a value derived from the key's current content: `compute` receives the value the file holds
 * while the lock is held, so a concurrent writer's change to the same file is built on, not overwritten.
 */
export async function updateSettingsKey(
	ctx: ConfigContext,
	scope: FileScope,
	key: string,
	compute: (current: unknown) => unknown,
): Promise<void> {
	// Through the manager's own storage, after the writes it queued: it reads back exactly what this wrote.
	await ctx.settings.rewriteScope(scope, (current) => {
		const parsed: unknown = current === undefined ? {} : JSON.parse(stripBom(current));
		if (!isObject(parsed)) throw new Error(`The ${scope} settings file is not a JSON object.`);
		const value = compute(readPath(parsed, key));
		if (current === undefined && value === undefined) return undefined;
		const parts = key.split(".");
		const chain: Record<string, unknown>[] = [parsed];
		for (const part of parts.slice(0, -1)) {
			const next = chain[chain.length - 1][part];
			if (isObject(next)) chain.push(next);
			else if (value === undefined) break;
			else {
				const created: Record<string, unknown> = {};
				chain[chain.length - 1][part] = created;
				chain.push(created);
			}
		}
		if (chain.length === parts.length) {
			const leaf = parts[parts.length - 1];
			if (value === undefined) delete chain[chain.length - 1][leaf];
			else chain[chain.length - 1][leaf] = value;
			// Prune sections the removal emptied.
			for (let depth = chain.length - 1; depth > 0 && Object.keys(chain[depth]).length === 0; depth--)
				delete chain[depth - 1][parts[depth - 1]];
		}
		return JSON.stringify(parsed, null, 2);
	});
}
