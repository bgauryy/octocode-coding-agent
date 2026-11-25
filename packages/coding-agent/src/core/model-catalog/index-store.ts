import { Models, type ProviderMap } from "@opencode-ai/models";
import fs from "node:fs";
import path from "node:path";
import { getBuiltinModelsDevSource, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { atomicWriteFile } from "@octocodeai/octocode-common/atomic-file";
import { envFlag } from "@octocodeai/octocode-common/env";
import { privateDir } from "@octocodeai/octocode-common/file-mode";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { globalPaths } from "../../storage/state-paths.ts";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import {
	type Catalog,
	CATALOG_VERSION,
	type CatalogListings,
	type CatalogModel,
	catalogListings,
	indexCatalog,
	isCurrentCatalog,
	listingOf,
	partialCatalog,
} from "./index-shape.ts";
import { asRoutingParts, routingFileOf, routingParts } from "./routing-parts.ts";

/**
 * The runtime owner of the models.dev index: fetched in the background at most once a day, saved in the agent state
 * folder, and used stale or not at all when offline. Every decision also works from Octocode's own metadata alone.
 *
 * Three files: the whole index (`models-dev.json`, read by templates and the `models` tool on first use), the listings
 * of the built-in providers only (`models-dev-builtin.json`), which the catalog update reads when a process starts, so
 * starting does not parse the whole index, and what routing reads besides them (`models-dev-routing.json`,
 * `routing-parts.ts`): routing reads the whole index only for a model they do not cover (`routingCatalog`).
 */

const HOUR_MS = 60 * 60 * 1000;
/** How long a fetched index is fresh. */
export const CATALOG_TTL_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 10_000;

/** `OCTOCODE_MODELS_DEV=0` keeps models.dev off: no request, and only Octocode's metadata routes and lists models. */
export const MODELS_DEV_ENV = "OCTOCODE_MODELS_DEV";

export const modelsDevEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => envFlag(env, MODELS_DEV_ENV, true);

/** Whether this process may fetch the index: models.dev on, and not offline (`--offline`, `OCTOCODE_OFFLINE`). */
export const modelsDevFetchEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
	modelsDevEnabled(env) && !isOfflineModeEnabled(env);

/** Where the index is kept. */
export function catalogFile(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(globalPaths(env).agentState, "models-dev.json");
}

/** Where the built-in providers' listings are kept, beside the index `file`. */
export const listingsFileOf = (file: string): string =>
	path.join(path.dirname(file), `${path.basename(file, ".json")}-builtin.json`);

/** The built-in providers' listings: what the catalog update reads, by models.dev provider and id. */
interface ListingsFile {
	version: number;
	fetchedAt: number;
	/** The models.dev providers this file was written for (one models.dev does not list has no entry in `listings`). */
	covers: ReadonlySet<string>;
	listings: Record<string, Record<string, CatalogModel>>;
}

/** Per file: the last parsed content, kept while the file's inode, size and mtime are unchanged. */
const parsedCache = new Map<string, { stamp: string; value: unknown }>();
/** Per index file: why the saved file was ignored, or the last fetch or save failure. `catalogStatus` reports it. */
const problems = new Map<string, string>();
/** Index files this process fetched itself (`catalogStatus().source` is then `live`). */
const fetchedHere = new Set<string>();
/** An index this process fetched but could not save: used until it goes stale, so it is not fetched again per call. */
const unsaved = new Map<string, Catalog>();

/** `file` parsed by `parse`, from the cache while unchanged; undefined when missing, unreadable or not that shape. */
function readParsed<T>(file: string, parse: (value: unknown) => T | undefined, problemFile = file): T | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !unsaved.has(problemFile))
			problems.set(problemFile, `index unreadable: ${errorMessage(error)}`);
		return undefined;
	}
	const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	const cached = parsedCache.get(file);
	if (cached?.stamp === stamp) return cached.value as T | undefined;
	let value: T | undefined;
	try {
		value = parse(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
		if (value === undefined) problems.set(problemFile, "index ignored: not a models.dev index");
	} catch (error) {
		// A malformed or half-written file: ignored, reported by `catalogStatus`, and replaced by the next fetch.
		problems.set(problemFile, `index ignored: ${errorMessage(error)}`);
	}
	parsedCache.set(file, { stamp, value });
	return value;
}

const asCatalog = (value: unknown): Catalog | undefined =>
	isRecord(value) && typeof value.fetchedAt === "number" && isRecord(value.models) && Array.isArray(value.providers)
		? (value as unknown as Catalog)
		: undefined;

const asListings = (value: unknown): ListingsFile | undefined =>
	isRecord(value) &&
	value.version === CATALOG_VERSION &&
	typeof value.fetchedAt === "number" &&
	Array.isArray(value.covers) &&
	isRecord(value.listings)
		? { ...(value as unknown as ListingsFile), covers: new Set(value.covers as string[]) }
		: undefined;

/**
 * The index to use: the saved one, fresh or stale, or this process's unsaved copy when newer; undefined when there is
 * none or it cannot be read (the reason is kept for `catalogStatus`). An index saved by an earlier Octocode is returned
 * too (routing reads its bare ids) and refetched by the next `loadCatalog`.
 */
export function readCatalog(file = catalogFile()): Catalog | undefined {
	const saved = readParsed(file, asCatalog);
	const kept = unsaved.get(file);
	return kept && (!saved || kept.fetchedAt >= saved.fetchedAt) ? kept : saved;
}

let builtinKeys: readonly string[] | undefined;

/** The models.dev providers the catalog update reads: each built-in provider, and the listings the data manifest names. */
export function builtinListingKeys(): readonly string[] {
	if (builtinKeys) return builtinKeys;
	const sources = Object.values(getBuiltinModelsDevSource()?.sources ?? {});
	builtinKeys = [
		...new Set([
			...getBuiltinProviders(),
			...sources.flatMap((source) => [source.listing, ...(source.prices ? [source.prices] : [])]),
		]),
	];
	return builtinKeys;
}

const covers = (listings: ListingsFile | undefined, keys: readonly string[]) =>
	listings !== undefined && keys.every((key) => listings.covers.has(key));

/**
 * The listings the catalog update reads for `keys`: from the small built-in listings file when it covers them, else
 * from the whole index (an index saved by an earlier Octocode has none). Undefined when there is no usable index.
 */
export function readListings(
	keys: readonly string[] = builtinListingKeys(),
	file = catalogFile(),
): CatalogListings | undefined {
	const small = unsaved.has(file) ? undefined : readParsed(listingsFileOf(file), asListings, file);
	if (small && covers(small, keys)) {
		const { listings } = small;
		return (provider) => listings[provider];
	}
	const catalog = readCatalog(file);
	return catalog && isCurrentCatalog(catalog) ? catalogListings(catalog) : undefined;
}

/** The built-in listings file for `catalog`: its `keys` providers' entries, every field kept (routing reads them too). */
function listingsFor(catalog: Catalog, keys: readonly string[]) {
	const listings: Record<string, Record<string, CatalogModel>> = {};
	for (const key of keys) {
		const listing = listingOf(catalog, key);
		if (listing) listings[key] = listing;
	}
	return { version: CATALOG_VERSION, fetchedAt: catalog.fetchedAt, covers: keys, listings };
}

/**
 * Saves `catalog`, its built-in listings and its routing parts (those first: a reader never finds them older than the
 * index). The listings keep the providers the previous file covered too, so two Octocode versions sharing a home do not
 * refetch in turn.
 */
export async function saveCatalog(file: string, catalog: Catalog, own = builtinListingKeys()): Promise<void> {
	const previous = readParsed(listingsFileOf(file), asListings, file);
	const keys = [...new Set([...own, ...(previous?.covers ?? [])])];
	privateDir(path.dirname(file));
	const write = (target: string, value: unknown) =>
		atomicWriteFile(target, JSON.stringify(value), undefined, { mode: 0o600 });
	await write(listingsFileOf(file), listingsFor(catalog, keys));
	await write(routingFileOf(file), routingParts(catalog));
	await write(file, catalog);
}

/** The fetch in flight per index file: callers of one file share it, and another file never takes its result. */
const refreshing = new Map<string, Promise<Catalog | undefined>>();
/** After a failed fetch (offline, blocked), no new attempt for this long, per index file. */
const RETRY_AFTER_MS = HOUR_MS;
const failedAt = new Map<string, number>();

async function fetchCatalog(file: string, now: number, fetchImpl: typeof fetch | undefined): Promise<Catalog> {
	const providers: ProviderMap = await Models.make({ fetch: fetchImpl }).providers({
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const catalog = indexCatalog(providers, now);
	if (Object.keys(catalog.models).length === 0) throw new Error("models.dev returned an empty catalog");
	failedAt.delete(file);
	problems.delete(file);
	fetchedHere.add(file);
	// Another process may have saved a newer index while this request ran; an older answer must not replace it.
	const current = readCatalog(file);
	if (current && isCurrentCatalog(current) && current.fetchedAt > catalog.fetchedAt) return current;
	try {
		await saveCatalog(file, catalog);
		unsaved.delete(file);
	} catch (error) {
		// Not saved (a read-only home): this process keeps the fresh index until it goes stale, with no new request.
		unsaved.set(file, catalog);
		problems.set(file, `index not saved, this process keeps its copy: ${errorMessage(error)}`);
	}
	return catalog;
}

/** Whether the saved index (and its built-in listings) can be used without a refetch at `now`. */
function upToDate(file: string, catalog: Catalog | undefined, now: number): catalog is Catalog {
	if (!catalog || now - catalog.fetchedAt >= CATALOG_TTL_MS || !isCurrentCatalog(catalog)) return false;
	return (
		unsaved.get(file) === catalog || covers(readParsed(listingsFileOf(file), asListings, file), builtinListingKeys())
	);
}

/**
 * The index, refreshed from models.dev when missing, older than a day, or saved by an earlier Octocode (one request at a
 * time per process). Callers check `modelsDevEnabled` first. Never throws: offline it fetches nothing, and on a bad
 * response it keeps the reason for `catalogStatus`; either way it returns the saved index, stale or not, or undefined.
 */
export async function loadCatalog(
	options: { file?: string; now?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<Catalog | undefined> {
	const env = options.env ?? process.env;
	const file = options.file ?? catalogFile(env);
	const now = options.now ?? Date.now();
	const saved = readCatalog(file);
	if (upToDate(file, saved, now) || isOfflineModeEnabled(env)) return saved;
	const failed = failedAt.get(file);
	if (failed !== undefined && now - failed < RETRY_AFTER_MS) return saved;
	const running = refreshing.get(file);
	if (running) return running;
	if (saved && !isCurrentCatalog(saved)) problems.set(file, "index saved by an earlier Octocode: refetching");
	const started = fetchCatalog(file, now, options.fetchImpl)
		.catch((error: unknown) => {
			// Offline, blocked or a bad answer: a background refresh, never part of a request.
			failedAt.set(file, now);
			problems.set(file, `models.dev fetch failed: ${errorMessage(error)}`);
			return saved;
		})
		.finally(() => refreshing.delete(file));
	refreshing.set(file, started);
	return started;
}

/**
 * The index to use now (the saved one, or undefined), refreshing it in the background for later calls. Off with
 * `OCTOCODE_MODELS_DEV=0`; offline it reads the saved index and fetches nothing. A fresh saved index is not parsed
 * whole: `refreshCatalog` vouches for it from its first bytes, and routing reads only its partial files.
 */
export function currentCatalog(env: NodeJS.ProcessEnv = process.env): Catalog | undefined {
	if (!modelsDevEnabled(env)) return undefined;
	refreshCatalog(env);
	return routingCatalog(catalogFile(env));
}

/** Per index file: the partial index `routingCatalog` built from one parse of the listings and routing files. */
const partials = new Map<string, { small: ListingsFile; parts: unknown; catalog: Catalog }>();

/**
 * The index routing reads (`currentRouting`, a spawn's routes), without parsing the whole of it: a partial index from
 * the built-in listings and the routing parts, which reads the whole index only for a provider or bare id they do not
 * hold, so every lookup answers as the whole index would. The whole index when they cannot stand in for it: this
 * process keeps an unsaved copy, the routing parts are missing (an earlier Octocode saved the index), or the three files
 * are not one fetch.
 */
export function routingCatalog(file = catalogFile()): Catalog | undefined {
	if (unsaved.has(file)) return readCatalog(file);
	const small = readParsed(listingsFileOf(file), asListings, file);
	const parts = small && readParsed(routingFileOf(file), asRoutingParts);
	const head = parts && savedHead(file);
	if (!small || !parts || head?.version !== CATALOG_VERSION || head.fetchedAt !== small.fetchedAt)
		return readCatalog(file);
	if (parts.fetchedAt !== small.fetchedAt) return readCatalog(file);
	const kept = partials.get(file);
	if (kept?.small === small && kept.parts === parts) return kept.catalog;
	const catalog = partialCatalog({ ...parts, listings: small.listings }, () => readCatalog(file));
	partials.set(file, { small, parts, catalog });
	return catalog;
}

/**
 * The version and `fetchedAt` of a saved index read from its first bytes (`JSON.stringify` of an index writes them first,
 * and a whole file ends `]}`), so a fresh one need not be parsed. Undefined when the file is missing or does not look so.
 */
function savedHead(file: string): { version: number; fetchedAt: number } | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const head = Buffer.alloc(Math.min(64, size));
		const tail = Buffer.alloc(Math.min(2, size));
		fs.readSync(fd, head, 0, head.length, 0);
		fs.readSync(fd, tail, 0, tail.length, size - tail.length);
		const at = /^\{"version":(\d+),"fetchedAt":(\d+)[,}]/.exec(head.toString("utf8"));
		return at && tail.toString("utf8") === "]}" ? { version: Number(at[1]), fetchedAt: Number(at[2]) } : undefined;
	} catch {
		// Missing or unreadable: the refresh below reads it properly and keeps the reason.
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * The background refresh `currentCatalog` starts, for a session that does not route yet: a saved index that is still
 * fresh and current is not read (its first reader parses it); a missing, stale, earlier or unrecognised one goes through
 * `loadCatalog`. Nothing is fetched offline or with models.dev off.
 */
export function refreshCatalog(env: NodeJS.ProcessEnv = process.env): void {
	if (!modelsDevFetchEnabled(env)) return;
	const file = catalogFile(env);
	const head = savedHead(file);
	const fresh = head?.version === CATALOG_VERSION && Date.now() - head.fetchedAt < CATALOG_TTL_MS;
	if (fresh && covers(readParsed(listingsFileOf(file), asListings, file), builtinListingKeys())) return;
	void loadCatalog({ file, env });
}

/** What this process knows about the index `file`: why it was ignored or not refreshed, and whether it fetched it. */
export function indexFacts(file: string): { problem: string | undefined; live: boolean } {
	return { problem: problems.get(file), live: fetchedHere.has(file) };
}
