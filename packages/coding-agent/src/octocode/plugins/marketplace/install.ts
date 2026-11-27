import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import path from "node:path";
import { discoverPluginManifests, resolvePluginPath } from "../../../core/plugin-manifest.ts";
import { pluginContext } from "../../../core/plugin-context.ts";
import { pluginToggleId } from "../../../core/extensibility/toggles.ts";
import type { Settings } from "../../../core/settings-schema.ts";
import { type CatalogPlugin, readCatalog } from "./catalog.ts";
import { copyPluginTree, treeHash } from "./copy.ts";
import { declarationChanges, type Declarations, describeDeclarations, readDeclarations } from "./declarations.ts";
import { shallowClone } from "./fetch.ts";
import {
	forgetMarketplaceFiles,
	marketplaceRoot,
	marketplaceSha,
	type MarketplaceHost,
	scratchDir,
	updateMarketplace,
} from "./registry.ts";
import { MarketplaceError } from "./source.ts";

type PluginEntry = NonNullable<Settings["plugins"]>[number];
type InstalledEntry = PluginEntry & { source: NonNullable<PluginEntry["source"]> };

/** How the user approves what a plugin runs: `yes` for `--yes`, `confirm` when there is somewhere to ask. */
export interface ConsentIo {
	yes?: boolean;
	confirm?: (question: string) => Promise<boolean> | undefined;
}

/** Approval was needed and could not be asked for. The CLI exits non-zero. */
class ConsentRequiredError extends MarketplaceError {}

/** Installing or enabling a plugin approves its hooks and MCP servers; this asks for that approval, or fails without it. */
async function approve(io: ConsentIo, title: string, lines: string[]): Promise<void> {
	if (io.yes) return;
	const body = `${title}\n${lines.map((line) => `  ${line}`).join("\n")}`;
	const answer = io.confirm?.(`${body}\nApprove?`);
	if (answer === undefined)
		throw new ConsentRequiredError(
			`${body}\nApproval needed: run this in a terminal to confirm, or pass --yes to approve.`,
		);
	if (!(await answer)) throw new MarketplaceError("Not approved; nothing was changed.");
}

function splitPluginId(id: string): { plugin: string; marketplace: string } {
	const at = id.lastIndexOf("@");
	if (at <= 0 || at === id.length - 1)
		throw new MarketplaceError(`Use <plugin>@<marketplace>, for example: fixture@team (got "${id}").`);
	return { plugin: id.slice(0, at), marketplace: id.slice(at + 1) };
}

const installedEntries = (host: MarketplaceHost): InstalledEntry[] =>
	(host.settings.getGlobalSettings().plugins ?? []).filter(
		(entry): entry is InstalledEntry => entry.source !== undefined,
	);

const findInstalled = (host: MarketplaceHost, plugin: string, marketplace: string) =>
	installedEntries(host).find((entry) => entry.source.plugin === plugin && entry.source.marketplace === marketplace);

const pluginId = (entry: InstalledEntry): string => `${entry.source.plugin}@${entry.source.marketplace}`;

export function listInstalled(host: MarketplaceHost): { id: string; sha: string; enabled: boolean; path: string }[] {
	return installedEntries(host).map((entry) => ({
		id: pluginId(entry),
		sha: entry.source.sha,
		enabled: entry.enabled !== false,
		path: entry.path,
	}));
}

interface Staged {
	dir: string;
	sha: string;
	declarations: Declarations;
	entry: CatalogPlugin;
	discard(): void;
}

/** A marketplace entry without its own `plugin.json` is named by the entry, so its skills carry the entry's name. */
function ensureManifest(dir: string, entry: CatalogPlugin): void {
	const folder = path.join(dir, ".claude-plugin");
	const file = path.join(folder, "plugin.json");
	if (existsSync(file)) return;
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			{
				name: entry.name,
				...(entry.version ? { version: entry.version } : {}),
				...(entry.description ? { description: entry.description } : {}),
			},
			null,
			2,
		),
	);
}

function requireDirectory(root: string, relative: string): string {
	try {
		const real = resolvePluginPath(root, relative);
		if (!statSync(real).isDirectory()) throw new MarketplaceError(`${relative} is not a directory.`);
		return real;
	} catch (error) {
		if (error instanceof MarketplaceError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new MarketplaceError(`Source path does not exist: ${relative}`);
		throw new MarketplaceError(errorMessage(error));
	}
}

/** Fetch one plugin into scratch space (a copy without `.git`), and read what it declares. Nothing in it runs. */
async function stage(host: MarketplaceHost, marketplace: string, entry: CatalogPlugin): Promise<Staged> {
	if (!entry.source) throw new MarketplaceError(`Plugin "${entry.name}": ${entry.problem ?? "no usable source"}`);
	const record = host.settings.getMarketplaces()[marketplace];
	const scratch = scratchDir(host);
	const discard = () => rmSync(scratch, { recursive: true, force: true });
	try {
		let root: string;
		let sha: string | undefined;
		let relative: string;
		if (entry.source.kind === "relative") {
			root = marketplaceRoot(host, marketplace, record.source);
			sha = marketplaceSha(host, marketplace);
			relative = entry.source.path;
		} else {
			root = path.join(scratch, "repo");
			sha = await shallowClone(entry.source.url, root, {
				ref: entry.source.ref,
				sha: entry.source.sha,
				env: host.env,
				timeoutMs: host.timeoutMs,
			});
			relative = entry.source.subdir ?? ".";
		}
		const dir = path.join(scratch, "plugin");
		copyPluginTree(requireDirectory(root, relative), dir);
		ensureManifest(dir, entry);
		return { dir, sha: sha ?? `dir-${treeHash(dir)}`, declarations: readDeclarations(dir), entry, discard };
	} catch (error) {
		discard();
		throw error;
	}
}

function place(host: MarketplaceHost, marketplace: string, staged: Staged): string {
	const target = path.join(host.paths.cache, marketplace, staged.entry.name, staged.sha);
	mkdirSync(path.dirname(target), { recursive: true });
	rmSync(target, { recursive: true, force: true });
	renameSync(staged.dir, target);
	return target;
}

function catalogEntry(host: MarketplaceHost, plugin: string, marketplace: string): CatalogPlugin {
	const record = host.settings.getMarketplaces()[marketplace];
	if (!record)
		throw new MarketplaceError(`Unknown marketplace "${marketplace}". Add it first: marketplace add <source>`);
	const catalog = readCatalog(marketplaceRoot(host, marketplace, record.source));
	const found = catalog.plugins.find((candidate) => candidate.name === plugin);
	if (!found)
		throw new MarketplaceError(
			`Plugin "${plugin}" not found in marketplace "${marketplace}". Available: ${catalog.plugins.map((item) => item.name).join(", ") || "none"}.`,
		);
	return found;
}

export interface InstallResult {
	id: string;
	sha: string;
	path: string;
	declarations: Declarations;
	ignored: string[];
}

/** `plugin install <plugin@marketplace>`: fetch, show hooks and MCP, ask when there are any, then enable. */
export async function installPlugin(host: MarketplaceHost, id: string, io: ConsentIo): Promise<InstallResult> {
	const { plugin, marketplace } = splitPluginId(id);
	const entry = catalogEntry(host, plugin, marketplace);
	const existing = findInstalled(host, plugin, marketplace);
	if (existing)
		throw new MarketplaceError(
			`${id} is already installed (${existing.source.sha.slice(0, 12)}). Update it with: plugin update ${id}`,
		);
	const staged = await stage(host, marketplace, entry);
	try {
		const lines = describeDeclarations(staged.declarations);
		if (lines.length) await approve(io, `${id} runs these hooks and MCP servers once installed:`, lines);
		const target = place(host, marketplace, staged);
		const record: InstalledEntry = {
			path: target,
			protocol: "claude",
			enabled: true,
			source: { marketplace, plugin, sha: staged.sha },
		};
		host.settings.setGlobalPlugins([...(host.settings.getGlobalSettings().plugins ?? []), record]);
		await host.settings.flush();
		return { id, sha: staged.sha, path: target, declarations: staged.declarations, ignored: entry.ignored };
	} finally {
		staged.discard();
	}
}

export interface UpdateResult {
	id: string;
	status: "updated" | "current" | "failed";
	message: string;
	changes: string[];
}

async function updateOne(host: MarketplaceHost, entry: InstalledEntry, io: ConsentIo): Promise<UpdateResult> {
	const id = pluginId(entry);
	const staged = await stage(
		host,
		entry.source.marketplace,
		catalogEntry(host, entry.source.plugin, entry.source.marketplace),
	);
	try {
		if (staged.sha === entry.source.sha)
			return { id, status: "current", message: `${id} is up to date (${staged.sha.slice(0, 12)}).`, changes: [] };
		const changes = declarationChanges(readDeclarations(entry.path), staged.declarations);
		if (changes.length) await approve(io, `${id} changed what it runs:`, changes);
		const target = place(host, entry.source.marketplace, staged);
		const from = entry.path;
		const plugins = (host.settings.getGlobalSettings().plugins ?? []).map((item) =>
			item.path === from ? { ...item, path: target, source: { ...entry.source, sha: staged.sha } } : item,
		);
		const toggles = host.settings.getToggles();
		const toggle = toggles[pluginToggleId(from)];
		if (toggle !== undefined && target !== from) {
			host.settings.setToggle("global", pluginToggleId(from), undefined);
			host.settings.setToggle("global", pluginToggleId(target), toggle);
		}
		host.settings.setGlobalPlugins(plugins);
		await host.settings.flush();
		if (target !== from) rmSync(from, { recursive: true, force: true });
		return { id, status: "updated", message: `${id} updated to ${staged.sha.slice(0, 12)}.`, changes };
	} finally {
		staged.discard();
	}
}

/**
 * `plugin update [id]`: refresh the marketplace, fetch each plugin again and pin the new commit. An update that
 * changes the plugin's hook or MCP declarations asks again. One plugin failing does not stop the others.
 */
export async function updatePlugins(
	host: MarketplaceHost,
	id: string | undefined,
	io: ConsentIo,
): Promise<UpdateResult[]> {
	const entries = installedEntries(host);
	const chosen = id ? entries.filter((entry) => pluginId(entry) === id) : entries;
	if (id && chosen.length === 0)
		throw new MarketplaceError(`${id} is not installed from a marketplace. Run: plugin list`);
	const failedMarketplaces = new Map<string, string>();
	for (const marketplace of new Set(chosen.map((entry) => entry.source.marketplace)))
		await updateMarketplace(host, marketplace).catch(
			(error: unknown) => void failedMarketplaces.set(marketplace, errorMessage(error)),
		);
	const results: UpdateResult[] = [];
	for (const entry of chosen) {
		const why = failedMarketplaces.get(entry.source.marketplace);
		try {
			if (why) throw new MarketplaceError(`Marketplace ${entry.source.marketplace} did not update: ${why}`);
			results.push(await updateOne(host, entry, io));
		} catch (error) {
			results.push({
				id: pluginId(entry),
				status: "failed",
				message: errorMessage(error),
				changes: [],
			});
		}
	}
	return results;
}

/** Delete the cache and data of one installed plugin and its settings entry and switch. */
async function uninstall(host: MarketplaceHost, entry: InstalledEntry): Promise<void> {
	const { marketplace, plugin } = entry.source;
	const manifest = discoverPluginManifests(entry.path, { protocol: "claude" }).manifests[0];
	const data = manifest ? pluginContext(manifest).data : undefined;
	host.settings.setGlobalPlugins(
		(host.settings.getGlobalSettings().plugins ?? []).filter((item) => item.path !== entry.path),
	);
	if (host.settings.getToggles()[pluginToggleId(entry.path)] !== undefined)
		host.settings.setToggle("global", pluginToggleId(entry.path), undefined);
	rmSync(path.join(host.paths.cache, marketplace, plugin), { recursive: true, force: true });
	if (data) rmSync(data, { recursive: true, force: true });
	await host.settings.flush();
}

/** `plugin remove <id>`: disable it and delete its cached copy and its data folder. */
export async function removePlugin(host: MarketplaceHost, id: string): Promise<void> {
	const { plugin, marketplace } = splitPluginId(id);
	const entry = findInstalled(host, plugin, marketplace);
	if (!entry) throw new MarketplaceError(`${id} is not installed. Run: plugin list`);
	await uninstall(host, entry);
}

/** `marketplace remove <name>`: uninstall its plugins, then delete the marketplace copy and its registry entry. */
export async function removeMarketplace(host: MarketplaceHost, name: string): Promise<string[]> {
	const known = host.settings.getMarketplaces();
	if (!Object.hasOwn(known, name)) throw new MarketplaceError(`Unknown marketplace "${name}". Run: marketplace list`);
	const removed: string[] = [];
	for (const entry of installedEntries(host).filter((item) => item.source.marketplace === name)) {
		await uninstall(host, entry);
		removed.push(pluginId(entry));
	}
	rmSync(path.join(host.paths.cache, name), { recursive: true, force: true });
	forgetMarketplaceFiles(host, name);
	const { [name]: _gone, ...rest } = known;
	host.settings.setMarketplaces(rest);
	await host.settings.flush();
	return removed;
}
