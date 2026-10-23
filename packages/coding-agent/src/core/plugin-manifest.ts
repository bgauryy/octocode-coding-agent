import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { stripBom } from "../utils/text.ts";

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

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function isPluginIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/[\s@:\/\\\p{Cc}\p{Cf}]/u.test(value) && value !== "." && value !== "..";
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
export function discoverPluginManifests(root: string, options: { protocol?: PluginManifest["protocol"] } = {}): { manifests: PluginManifest[]; errors: string[] } {
	const manifests: PluginManifest[] = [];
	const errors: string[] = [];
	const read = (entry: string): { present: boolean; value?: Record<string, unknown>; source?: string } => {
		try { lstatSync(path.resolve(root, entry)); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
			errors.push(`${entry}: ${String(error)}`);
			return { present: true };
		}
		try {
			const source = resolvePluginPath(root, entry);
			const value: unknown = JSON.parse(stripBom(readFileSync(source, "utf8")));
			if (!object(value)) throw new Error("manifest must be an object");
			return { present: true, value, source };
		} catch (error) {
			errors.push(`${entry}: ${String(error)}`);
			return { present: true };
		}
	};
	const add = (protocol: PluginManifest["protocol"], format: PluginManifest["format"], metadata: Record<string, unknown>, settings: Record<string, unknown>, sources: string[]) => {
		const name = format === "codex" && (metadata.name === undefined || (typeof metadata.name === "string" && !metadata.name.trim()))
			? path.basename(realpathSync(root)) : metadata.name;
		if (!isPluginIdentifier(name)) {
			errors.push(`${sources[0] ?? root}: plugin name must be a non-empty namespace identifier without spaces, separators or control characters`);
			return;
		}
		manifests.push({ protocol, format, name, root: realpathSync(root), sources, metadata, settings });
	};
	const claude = read("./.claude-plugin/plugin.json");
	if (claude.value) add("claude", "claude", claude.value, claude.value, [claude.source!]);
	else if (!claude.present && options.protocol === "claude") add("claude", "claude", { name: path.basename(realpathSync(root)) }, {}, []);
	const portable = read("./plugin.json");
	if (portable.present) {
		if (!portable.value) return { manifests, errors };
		const extensions = portable.value.extensions;
		const inline = object(extensions) ? extensions["com.openai"] : undefined;
		if (inline !== undefined && !object(inline)) {
			errors.push(`${portable.source}: extensions.com.openai must be an object`);
			return { manifests, errors };
		}
		if (object(inline)) add("codex", "portable", portable.value, inline, [portable.source!]);
		else {
			const overlay = read("./.codex-plugin/plugin.json");
			if (!overlay.present || overlay.value)
				add("codex", "portable", portable.value, overlay.value ?? {}, [portable.source!, ...(overlay.source ? [overlay.source] : [])]);
		}
	} else {
		const codex = read("./.codex-plugin/plugin.json");
		if (codex.value) add("codex", "codex", codex.value, codex.value, [codex.source!]);
	}
	return { manifests, errors };
}
