import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { type Catalog, MARKETPLACE_FILE, readCatalog } from "./catalog.ts";
import { isGitRepository, type MarketplacePaths, shallowClone } from "./fetch.ts";
import {
	checkGitUrl,
	checkMarketplaceName,
	describeSource,
	MarketplaceError,
	type MarketplaceSource,
	parseMarketplaceInput,
	sourceUrl,
} from "./source.ts";

/** What the marketplace and plugin operations act on: the user settings, the cache folders and the fetch limits. */
export interface MarketplaceHost {
	/** Only the global registry and global `plugins` are written. */
	settings: SettingsManager;
	paths: MarketplacePaths;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/** A marketplace fetched into scratch space, ready to be read or moved into place. */
interface FetchedMarketplace {
	root: string;
	sha?: string;
	catalog: Catalog;
	/** Remove the scratch copy (a no-op for a directory read in place). */
	discard(): void;
}

export function scratchDir(host: MarketplaceHost): string {
	mkdirSync(host.paths.tmp, { recursive: true, mode: 0o700 });
	return mkdtempSync(path.join(host.paths.tmp, "fetch-"));
}

/** The folder holding the marketplace files: the directory itself, or the copy `add` and `update` keep. */
export function marketplaceRoot(host: MarketplaceHost, name: string, source: MarketplaceSource): string {
	return source.source === "directory" ? source.path : path.join(host.paths.marketplaces, name);
}

const metaFile = (host: MarketplaceHost, name: string) => path.join(host.paths.meta, `${name}.json`);

/** The commit a git marketplace copy was fetched at. */
export function marketplaceSha(host: MarketplaceHost, name: string): string | undefined {
	try {
		const meta: unknown = JSON.parse(readFileSync(metaFile(host, name), "utf8"));
		return typeof (meta as { sha?: unknown }).sha === "string" ? (meta as { sha: string }).sha : undefined;
	} catch {
		return undefined;
	}
}

async function fetchMarketplace(host: MarketplaceHost, source: MarketplaceSource): Promise<FetchedMarketplace> {
	if (source.source === "directory") {
		if (!existsSync(source.path)) throw new MarketplaceError(`${source.path} does not exist.`);
		const root = realpathSync(source.path);
		return { root, catalog: readCatalog(root), discard: () => undefined };
	}
	const scratch = scratchDir(host);
	const discard = () => rmSync(scratch, { recursive: true, force: true });
	try {
		const root = path.join(scratch, "marketplace");
		const sha = await shallowClone(sourceUrl(source)!, root, {
			ref: source.ref,
			env: host.env,
			timeoutMs: host.timeoutMs,
		});
		return { root, sha, catalog: readCatalog(root), discard };
	} catch (error) {
		discard();
		throw error;
	}
}

/** Move a fetched git marketplace to `marketplaces/<name>` and record its commit. */
function keep(host: MarketplaceHost, name: string, fetched: FetchedMarketplace): void {
	if (!fetched.sha) return;
	const target = path.join(host.paths.marketplaces, name);
	mkdirSync(host.paths.meta, { recursive: true });
	rmSync(target, { recursive: true, force: true });
	renameSync(fetched.root, target);
	atomicWriteFileSync(metaFile(host, name), JSON.stringify({ sha: fetched.sha, fetchedAt: new Date().toISOString() }));
}

export function forgetMarketplaceFiles(host: MarketplaceHost, name: string): void {
	rmSync(path.join(host.paths.marketplaces, name), { recursive: true, force: true });
	rmSync(metaFile(host, name), { force: true });
}

/** Where `marketplace add <input>` fetches from. A local folder is read in place; a local git repository is cloned. */
function resolveSource(host: MarketplaceHost, input: string): MarketplaceSource {
	const expand = (text: string) =>
		path.resolve(host.cwd, text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text);
	const parsed = parseMarketplaceInput(input, (text) => existsSync(expand(text)));
	if (parsed.kind === "github")
		return { source: "github", repo: parsed.repo, ...(parsed.ref ? { ref: parsed.ref } : {}) };
	if (parsed.kind === "git") return { source: "git", url: parsed.url, ...(parsed.ref ? { ref: parsed.ref } : {}) };
	const directory = expand(parsed.path);
	if (!existsSync(directory) || !statSync(directory).isDirectory())
		throw new MarketplaceError(`${parsed.path} is not a directory.`);
	const real = realpathSync(directory);
	if (!existsSync(path.join(real, MARKETPLACE_FILE)) && isGitRepository(real))
		return { source: "git", url: checkGitUrl(real, { allowLocalPath: true }) };
	return { source: "directory", path: real };
}

export interface AddedMarketplace {
	name: string;
	source: MarketplaceSource;
	plugins: number;
}

/** `marketplace add`: fetch, read the catalog and register it under its own name. No plugin code runs. */
export async function addMarketplace(host: MarketplaceHost, input: string): Promise<AddedMarketplace> {
	const source = resolveSource(host, input);
	const fetched = await fetchMarketplace(host, source);
	try {
		const name = checkMarketplaceName(fetched.catalog.name);
		const known = host.settings.getMarketplaces();
		if (Object.hasOwn(known, name))
			throw new MarketplaceError(
				`A marketplace named "${name}" is already added (${describeSource(known[name].source)}). Remove it first with: marketplace remove ${name}`,
			);
		keep(host, name, fetched);
		host.settings.setMarketplaces({ ...known, [name]: { source, addedAt: new Date().toISOString() } });
		await host.settings.flush();
		return { name, source, plugins: fetched.catalog.plugins.length };
	} finally {
		fetched.discard();
	}
}

export interface MarketplaceRow {
	name: string;
	source: string;
	plugins: string[];
	sha?: string;
	problem?: string;
}

/** `marketplace list`: each registered marketplace and the plugins its catalog offers. */
export function listMarketplaces(host: MarketplaceHost): MarketplaceRow[] {
	return Object.entries(host.settings.getMarketplaces()).map(([name, record]) => {
		const row: MarketplaceRow = {
			name,
			source: describeSource(record.source),
			plugins: [],
			sha: marketplaceSha(host, name),
		};
		try {
			row.plugins = readCatalog(marketplaceRoot(host, name, record.source)).plugins.map((plugin) => plugin.name);
		} catch (error) {
			row.problem = errorMessage(error);
		}
		return row;
	});
}

export interface UpdatedMarketplace {
	name: string;
	status: "updated" | "current" | "local";
	sha?: string;
}

/** `marketplace update [name]`: fetch the default branch (or the pinned ref) again. A directory is read in place. */
export async function updateMarketplace(host: MarketplaceHost, name: string): Promise<UpdatedMarketplace> {
	const record = host.settings.getMarketplaces()[name];
	if (!record) throw new MarketplaceError(`Unknown marketplace "${name}". Run: marketplace list`);
	if (record.source.source === "directory") return { name, status: "local" };
	const before = marketplaceSha(host, name);
	const fetched = await fetchMarketplace(host, record.source);
	try {
		if (fetched.catalog.name !== name)
			throw new MarketplaceError(
				`The marketplace now calls itself "${fetched.catalog.name}", not "${name}"; nothing was changed.`,
			);
		if (fetched.sha === before && existsSync(path.join(host.paths.marketplaces, name)))
			return { name, status: "current", sha: before };
		keep(host, name, fetched);
		return { name, status: "updated", sha: fetched.sha };
	} finally {
		fetched.discard();
	}
}
