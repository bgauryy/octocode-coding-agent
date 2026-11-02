import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "../../../../../common/src/json.ts";
import { resolvePluginPath } from "../../../core/plugin-manifest.ts";
import { checkIdentifier, MarketplaceError, type PluginSource, parsePluginSource } from "./source.ts";

export interface CatalogPlugin {
	name: string;
	description?: string;
	version?: string;
	/** Undefined when the entry's source is refused or malformed: `problem` says why. */
	source?: PluginSource;
	problem?: string;
	/** Entry fields that declare components inline; the plugin's own files are used instead. */
	ignored: string[];
}

export interface Catalog {
	name: string;
	description?: string;
	plugins: CatalogPlugin[];
}

export const MARKETPLACE_FILE = "./.claude-plugin/marketplace.json";
const INLINE_COMPONENTS = [
	"hooks",
	"mcpServers",
	"commands",
	"agents",
	"skills",
	"lspServers",
	"outputStyles",
	"themes",
];

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Read `.claude-plugin/marketplace.json` of a marketplace root. Required: `name` and a `plugins` array. Each entry is
 * checked on its own, so one bad entry does not hide the others. The path is resolved with `resolvePluginPath`, so a
 * symlinked file cannot read outside the marketplace. Nothing in the marketplace runs.
 */
export function readCatalog(root: string): Catalog {
	let raw: unknown;
	try {
		raw = readJsonFile(resolvePluginPath(root, MARKETPLACE_FILE));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new MarketplaceError(
			code === "ENOENT"
				? `No ${MARKETPLACE_FILE.slice(2)} in ${root}.`
				: `Cannot read ${MARKETPLACE_FILE.slice(2)} in ${root}: ${errorMessage(error)}`,
		);
	}
	if (!isRecord(raw) || !Array.isArray(raw.plugins))
		throw new MarketplaceError(`${MARKETPLACE_FILE.slice(2)} must be an object with a name and a plugins array.`);
	const name = checkIdentifier("marketplace", raw.name);
	const metadata = isRecord(raw.metadata) ? raw.metadata : {};
	const pluginRoot = text(metadata.pluginRoot);
	const seen = new Set<string>();
	const plugins = raw.plugins.map((entry: unknown, index): CatalogPlugin => {
		const fields = isRecord(entry) ? entry : {};
		const label = text(fields.name) ?? `plugins[${index}]`;
		const plugin: CatalogPlugin = {
			name: label,
			description: text(fields.description),
			version: text(fields.version),
			ignored: INLINE_COMPONENTS.filter((key) => fields[key] !== undefined),
		};
		try {
			checkIdentifier("plugin", fields.name);
			if (seen.has(label)) throw new MarketplaceError(`Duplicate plugin name "${label}" in the marketplace.`);
			seen.add(label);
			plugin.source = parsePluginSource(fields.source, pluginRoot);
		} catch (error) {
			plugin.problem = errorMessage(error);
		}
		return plugin;
	});
	return { name, description: text(raw.description), plugins };
}
