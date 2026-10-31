import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "../../../common/src/json.ts";

export interface PluginManifest {
	protocol: "claude" | "codex";
	format: "claude" | "codex" | "portable";
	name: string;
	root: string;
	/** All files whose declarations contributed to this identity and its settings. */
	sources: string[];
	metadata: Record<string, unknown>;
	settings: Record<string, unknown>;
}

export function isPluginIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!/[\s@:/\\\p{Cc}\p{Cf}]/u.test(value) &&
		value !== "." &&
		value !== ".."
	);
}

/** Resolve package files before reading; lexical containment alone does not contain symlinks. */
export function resolvePluginPath(root: string, entry: string): string {
	if (!(entry === "." || entry.startsWith("./")) || entry.includes("\\") || entry.split("/").includes(".."))
		throw new Error(`Invalid plugin-relative path: ${entry}`);
	const realRoot = realpathSync(root);
	const file = realpathSync(path.resolve(realRoot, entry));
	const relative = path.relative(realRoot, file);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error(`Plugin path escapes package: ${entry}`);
	return file;
}

/** Read declarations only. Discovery neither trusts a plugin nor executes any component. */
export function discoverPluginManifests(
	root: string,
	options: { protocol?: PluginManifest["protocol"] } = {},
): { manifests: PluginManifest[]; errors: string[] } {
	const manifests: PluginManifest[] = [];
	const errors: string[] = [];
	const read = (entry: string): { present: boolean; value?: Record<string, unknown>; source?: string } => {
		try {
			lstatSync(path.resolve(root, entry));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
			errors.push(`${entry}: ${String(error)}`);
			return { present: true };
		}
		try {
			const source = resolvePluginPath(root, entry);
			const value: unknown = readJsonFile(source);
			if (!isRecord(value)) throw new Error("manifest must be an object");
			return { present: true, value, source };
		} catch (error) {
			errors.push(`${entry}: ${String(error)}`);
			return { present: true };
		}
	};
	const add = (
		protocol: PluginManifest["protocol"],
		format: PluginManifest["format"],
		metadata: Record<string, unknown>,
		settings: Record<string, unknown>,
		sources: string[],
	) => {
		const name =
			format === "codex" &&
			(metadata.name === undefined || (typeof metadata.name === "string" && !metadata.name.trim()))
				? path.basename(realpathSync(root))
				: metadata.name;
		if (!isPluginIdentifier(name)) {
			errors.push(
				`${sources[0] ?? root}: plugin name must be a non-empty namespace identifier without spaces, separators or control characters`,
			);
			return;
		}
		manifests.push({ protocol, format, name, root: realpathSync(root), sources, metadata, settings });
	};
	const claude = read("./.claude-plugin/plugin.json");
	if (claude.value) add("claude", "claude", claude.value, claude.value, [claude.source!]);
	else if (!claude.present && options.protocol === "claude")
		add("claude", "claude", { name: path.basename(realpathSync(root)) }, {}, []);
	const portable = read("./plugin.json");
	if (portable.present) {
		if (!portable.value) return { manifests, errors };
		const extensions = portable.value.extensions;
		const inline = isRecord(extensions) ? extensions["com.openai"] : undefined;
		if (inline !== undefined && !isRecord(inline)) {
			errors.push(`${portable.source}: extensions.com.openai must be an object`);
			return { manifests, errors };
		}
		if (isRecord(inline)) add("codex", "portable", portable.value, inline, [portable.source!]);
		else {
			const overlay = read("./.codex-plugin/plugin.json");
			if (!overlay.present || overlay.value)
				add("codex", "portable", portable.value, overlay.value ?? {}, [
					portable.source!,
					...(overlay.source ? [overlay.source] : []),
				]);
		}
	} else {
		const codex = read("./.codex-plugin/plugin.json");
		if (codex.value) add("codex", "codex", codex.value, codex.value, [codex.source!]);
	}
	return { manifests, errors };
}

export interface ConfiguredPluginResolution {
	manifest?: PluginManifest;
	/** Declaration errors reported by manifest discovery; they do not stop resolution. */
	errors: string[];
	/** Why no manifest resolved: a relative path or no manifest for the configured protocol. */
	failure?: string;
}

/**
 * Resolve the manifest of a configured plugin entry for its protocol. Shared by skill, hook and MCP activation so each
 * applies the same absolute-path check, discovery and protocol match. Discovery itself may throw.
 */
export function resolveConfiguredPlugin(entry: {
	path: string;
	protocol: PluginManifest["protocol"];
}): ConfiguredPluginResolution {
	if (!path.isAbsolute(entry.path)) return { errors: [], failure: "Plugin path must be absolute" };
	const discovery = discoverPluginManifests(entry.path, { protocol: entry.protocol });
	const manifest = discovery.manifests.find((item) => item.protocol === entry.protocol);
	return {
		errors: discovery.errors,
		...(manifest ? { manifest } : { failure: `No valid ${entry.protocol} plugin manifest found` }),
	};
}

/**
 * Start an approval fingerprint with the plugin identity and the text of every manifest source. Callers append the
 * declarations they review. Stored in user settings: the hashed bytes must not change.
 */
export function startPluginFingerprint(manifest: PluginManifest): Hash {
	const hash = createHash("sha256").update(JSON.stringify([manifest.root, manifest.protocol, manifest.name]));
	for (const source of manifest.sources) hash.update(JSON.stringify([source, readFileSync(source, "utf8")]));
	return hash;
}
