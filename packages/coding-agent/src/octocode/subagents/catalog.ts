import { Models, type Model as ModelsDevModel, type ProviderMap } from "@opencode-ai/models";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "@octocodeai/octocode-common/atomic-file";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { envFlag } from "@octocodeai/octocode-common/env";
import { globalPaths, privateDir } from "../shared/home.ts";
import { DAY_MS, finiteNumber, HOUR_MS } from "../shared/util.ts";

/**
 * Model metadata from models.dev (https://models.dev, MIT), an open catalog of model capabilities, limits and
 * prices: what Octocode's own model entries do not say (tool calling, input modalities, a description) or a custom provider
 * left out (price, window). Fetched in the background at most once a day, kept as a small index in the agent state
 * folder, and used stale or not at all when offline: every decision also works from Octocode's metadata alone.
 */

/** How long a fetched index is fresh. */
const CATALOG_TTL_MS = DAY_MS;
const FETCH_TIMEOUT_MS = 10_000;

/** What Octocode reads from one models.dev model entry (prices per million tokens). */
interface CatalogModel {
	description?: string;
	knowledge?: string;
	/** Model family (`claude-haiku`, `gpt-mini`): its newest release is the current one. */
	family?: string;
	/** Release date, `YYYY-MM-DD`. */
	released?: string;
	/** `deprecated` models are never chosen. */
	status?: string;
	/** The lab that made it (`anthropic`), from its canonical id. */
	lab?: string;
	toolCall?: boolean;
	reasoning?: boolean;
	input?: string[];
	context?: number;
	/** Maximum output tokens per response. */
	output?: number;
	/** Cache prices ride along with a listed input/output price (per million tokens). */
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	/** How reasoning is set (an effort list, a token budget, or a toggle), as models.dev lists it. */
	reasoningOptions?: ReasoningOption[];
}

type ReasoningOption = NonNullable<ModelsDevModel["reasoning_options"]>[number];

/**
 * The index: bare `id` to the model as its lab lists it (else the first provider listing it), plus `provider/id` only
 * where that provider's listing differs (a reseller's price), so the file stays small.
 */
export interface Catalog {
	fetchedAt: number;
	models: Record<string, CatalogModel>;
	/** The providers models.dev lists: only their models' missing prices are filled from it. */
	providers: string[];
}

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** `{ [key]: value }`, or nothing when the value is missing, so an absent field is not written. */
function field<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function entry(raw: Partial<ModelsDevModel>): CatalogModel {
	const limit = asRecord(raw.limit);
	const cost = isRecord(raw.cost) ? raw.cost : undefined;
	const input =
		isRecord(raw.modalities) && Array.isArray(raw.modalities.input)
			? raw.modalities.input.filter((item) => typeof item === "string")
			: undefined;
	const price =
		cost && finiteNumber(cost.input) !== undefined && finiteNumber(cost.output) !== undefined
			? {
					input: finiteNumber(cost.input)!,
					output: finiteNumber(cost.output)!,
					...field("cacheRead", finiteNumber(cost.cache_read)),
					...field("cacheWrite", finiteNumber(cost.cache_write)),
				}
			: undefined;
	const context = finiteNumber(limit.context);
	const output = finiteNumber(limit.output);
	const options = Array.isArray(raw.reasoning_options)
		? raw.reasoning_options.filter((option) => isRecord(option) && typeof option.type === "string")
		: [];
	const canonical = str(raw.canonical_model_id);
	return {
		...field("description", str(raw.description)),
		...field("knowledge", str(raw.knowledge)),
		...field("family", str(raw.family)),
		...field("released", str(raw.release_date)),
		...field("status", str(raw.status)),
		...field("lab", canonical?.includes("/") ? canonical.split("/")[0] : undefined),
		...(typeof raw.tool_call === "boolean" ? { toolCall: raw.tool_call } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...field("input", input),
		...field("context", context === 0 ? undefined : context),
		...field("output", output === 0 ? undefined : output),
		...field("cost", price),
		...(options.length > 0 ? { reasoningOptions: options } : {}),
	};
}

/** The index of models.dev's `api.json` (providers, each with its models). */
export function indexCatalog(api: unknown, fetchedAt: number): Catalog {
	const listed: Array<[string, string, CatalogModel]> = [];
	const bare = new Map<string, { model: CatalogModel; lab: boolean }>();
	for (const [provider, raw] of Object.entries(asRecord(api))) {
		if (!isRecord(raw) || !isRecord(raw.models)) continue;
		for (const [id, value] of Object.entries(raw.models)) {
			if (!isRecord(value)) continue;
			const model = entry(value);
			listed.push([provider, id, model]);
			// A bare id resolves to the model's own lab first (`anthropic/claude-…` listed by `anthropic`), else the first.
			const canonical = str(value.canonical_model_id);
			const lab = canonical?.startsWith(`${provider}/`) ?? false;
			const seen = bare.get(id);
			if (!seen || (lab && !seen.lab)) bare.set(id, { model, lab });
		}
	}
	const models: Record<string, CatalogModel> = Object.fromEntries([...bare].map(([id, { model }]) => [id, model]));
	for (const [provider, id, model] of listed) {
		if (JSON.stringify(model) !== JSON.stringify(bare.get(id)!.model)) models[`${provider}/${id}`] = model;
	}
	return { fetchedAt, models, providers: Object.keys(asRecord(api)) };
}

/**
 * The price models.dev lists for a model of `provider`, only when it lists that provider: a local or private provider's
 * model (an Ollama `gpt-oss:20b`, priced 0 by Octocode) must not borrow a cloud price through its bare id.
 */
export function listedCost(catalog: Catalog | undefined, provider: string, id: string): CatalogModel["cost"] {
	return catalog?.providers?.includes(provider) ? lookup(catalog, provider, id)?.cost : undefined;
}

/** The models.dev entry for Octocode's `provider`/`id`: that provider's listing, else the bare id, else the id's last part. */
export function lookup(catalog: Catalog | undefined, provider: string, id: string): CatalogModel | undefined {
	if (!catalog) return undefined;
	const last = id.slice(id.lastIndexOf("/") + 1);
	return catalog.models[`${provider}/${id}`] ?? catalog.models[id] ?? catalog.models[last];
}

/** Where the index is kept. */
export function catalogFile(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(globalPaths(env).agentState, "models-dev.json");
}

/** The last parsed index by file, kept while the file's inode, size and mtime are unchanged (an `agent` call reads it every time). */
const parsedCache = new Map<string, { stamp: string; catalog: Catalog | undefined }>();

/** The saved index, fresh or stale, or undefined when there is none or it cannot be read. */

export function readCatalog(file = catalogFile()): Catalog | undefined {
	try {
		const { mtimeMs, size, ino } = fs.statSync(file);
		const stamp = `${ino}:${size}:${mtimeMs}`;
		const cached = parsedCache.get(file);
		if (cached?.stamp === stamp) return cached.catalog;
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		const catalog =
			isRecord(parsed) &&
			typeof parsed.fetchedAt === "number" &&
			isRecord(parsed.models) &&
			Array.isArray(parsed.providers)
				? (parsed as unknown as Catalog)
				: undefined;
		parsedCache.set(file, { stamp, catalog });
		return catalog;
	} catch {
		return undefined;
	}
}

/** The fetch in flight per index file: callers of one file share it, and another file never takes its result. */
const refreshing = new Map<string, Promise<Catalog | undefined>>();
/** After a failed fetch (offline, blocked), no new attempt for this long, per index file. */
const RETRY_AFTER_MS = HOUR_MS;
const failedAt = new Map<string, number>();

/**
 * The index, refreshed from models.dev when missing or older than `CATALOG_TTL_MS` (one request at a time per
 * process). Never throws: offline or on a bad response it returns the saved index, stale or not, or undefined.
 */
export async function loadCatalog(
	options: { file?: string; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<Catalog | undefined> {
	const file = options.file ?? catalogFile();
	const now = options.now ?? Date.now();
	const saved = readCatalog(file);
	if (saved && now - saved.fetchedAt < CATALOG_TTL_MS) return saved;
	const failed = failedAt.get(file);
	if (failed !== undefined && now - failed < RETRY_AFTER_MS) return saved;
	const running = refreshing.get(file);
	if (running) return running;
	const started = (async () => {
		try {
			const providers: ProviderMap = await Models.make({ fetch: options.fetchImpl }).providers({
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const catalog = indexCatalog(providers, now);
			if (Object.keys(catalog.models).length === 0) throw new Error("empty catalog");
			failedAt.delete(file);
			// Another process may have saved a newer index while this request ran; an older answer must not replace it.
			const current = readCatalog(file);
			if (current && current.fetchedAt > catalog.fetchedAt) return current;
			try {
				privateDir(path.dirname(file));
				await atomicWriteFile(file, JSON.stringify(catalog), undefined, { mode: 0o600 });
			} catch {
				// Not saved (a read-only home): this call still routes with the fresh index.
			}
			return catalog;
		} catch {
			failedAt.set(file, now);
			return saved;
		} finally {
			refreshing.delete(file);
		}
	})();
	refreshing.set(file, started);
	return started;
}

/** `OCTOCODE_MODELS_DEV=0` keeps models.dev off: no request, and only Octocode's metadata routes subagent models. */
export const MODELS_DEV_ENV = "OCTOCODE_MODELS_DEV";

/**
 * The index to route with now (the saved one, or undefined), refreshing it in the background for later calls. Off
 * with `OCTOCODE_MODELS_DEV=0`.
 */
export const modelsDevEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => envFlag(env, MODELS_DEV_ENV, true);

export function currentCatalog(env: NodeJS.ProcessEnv = process.env): Catalog | undefined {
	if (!modelsDevEnabled(env)) return undefined;
	const file = catalogFile(env);
	void loadCatalog({ file });
	return readCatalog(file);
}

/**
 * `fetchedAt` of a saved index read from its first bytes (`JSON.stringify` of an index writes it first, and a whole
 * file ends `]}`), so a fresh one need not be parsed. Undefined when the file is missing or does not look so.
 */
function savedAt(file: string): number | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const head = Buffer.alloc(Math.min(64, size));
		const tail = Buffer.alloc(Math.min(2, size));
		fs.readSync(fd, head, 0, head.length, 0);
		fs.readSync(fd, tail, 0, tail.length, size - tail.length);
		const at = /^\{"fetchedAt":(\d+)[,}]/.exec(head.toString("utf8"));
		return at && tail.toString("utf8") === "]}" ? Number(at[1]) : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * The background refresh `currentCatalog` starts, for a session that does not route yet: a saved index that is still
 * fresh is not read (its first reader parses it); a missing, stale or unrecognised one goes through `loadCatalog`.
 */
export function refreshCatalog(env: NodeJS.ProcessEnv = process.env): void {
	if (!modelsDevEnabled(env)) return;
	const file = catalogFile(env);
	const at = savedAt(file);
	if (at !== undefined && Date.now() - at < CATALOG_TTL_MS) return;
	void loadCatalog({ file });
}
