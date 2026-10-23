import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";
import type { Extension, ExtensionFactory, InlineExtension, LoadExtensionsResult } from "../extensions/types.ts";
import type { PathMetadata } from "../package-manager.ts";
import { BUILTIN_PATH_PREFIX } from "../source-info.ts";

const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
	"@octocodeai/octocode-agent-core",
	"@octocodeai/octocode-ai",
	"@octocodeai/octocodecode",
	"@octocodeai/octocode-tui",
	"@sinclair/typebox",
	"typebox",
]);

export function collectExtensionPackageWarnings(
	extensionPaths: string[],
	metadataByPath: Map<string, PathMetadata>,
): Array<{ path: string; warning: string }> {
	const warnings: Array<{ path: string; warning: string }> = [];
	const packageRoots = new Set(
		extensionPaths
			.map((extensionPath) => metadataByPath.get(extensionPath)?.packageRoot)
			.filter((packageRoot): packageRoot is string => packageRoot !== undefined),
	);
	for (const packageRoot of packageRoots) {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
		if (
			typeof manifest.dependencies !== "object" ||
			manifest.dependencies === null ||
			Array.isArray(manifest.dependencies)
		) {
			continue;
		}
		const hostDependencies = Object.keys(manifest.dependencies)
			.filter((name) => HOST_PROVIDED_EXTENSION_PACKAGES.has(name))
			.sort();
		if (hostDependencies.length === 0) continue;
		warnings.push({
			path: packageJsonPath,
			warning: `Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: ${hostDependencies.join(", ")}. Installed copies can bypass the extension loader and create duplicate runtime modules.`,
		});
	}
	return warnings;
}

export function mergeExtensionWarnings(
	result: LoadExtensionsResult,
	warnings: Array<{ path: string; warning: string }>,
): void {
	result.warnings = [
		...new Map([...(result.warnings ?? []), ...warnings].map((warning) => [warning.path, warning])).values(),
	];
}

export type BuiltinExtension = Exclude<InlineExtension, ExtensionFactory>;

/** Built-in extensions supply the code of `builtin:<name>` extension paths (see `InlineExtension`). */
export function isBuiltinExtension(input: InlineExtension): input is BuiltinExtension {
	return typeof input !== "function" && input.builtin === true;
}

/**
 * Leave out replaceable extensions (see `InlineExtension`) that share a tool, command, or flag name
 * with another extension. For example, a third-party MCP extension that registers `/mcp` replaces
 * the built-in MCP extension instead of both connecting the same servers.
 */
export function omitReplacedExtensions(
	extensions: Extension[],
	warnings?: Array<{ path: string; warning: string }>,
): Extension[] {
	const names = (extension: Extension) => [
		...[...extension.tools.keys()].map((name) => `tool:${name}`),
		...[...extension.commands.keys()].map((name) => `command:${name}`),
		...[...extension.flags.keys()].map((name) => `flag:${name}`),
	];
	const taken = new Map(
		extensions
			.filter((extension) => !extension.replaceable)
			.flatMap((extension) => names(extension).map((name) => [name, extension] as const)),
	);
	return extensions.filter((extension) => {
		if (!extension.replaceable) return true;
		const replacement = names(extension)
			.map((name) => ({ name, extension: taken.get(name) }))
			.find((value): value is { name: string; extension: Extension } => value.extension !== undefined);
		if (!replacement) return true;
		if (extension.path.startsWith(BUILTIN_PATH_PREFIX)) {
			const builtinName = extension.path.slice(BUILTIN_PATH_PREFIX.length);
			const [kind, rawName] = replacement.name.split(":", 2);
			const registeredName = kind === "command" ? `/${rawName}` : kind === "flag" ? `--${rawName}` : rawName;
			warnings?.push({
				path: extension.path,
				warning: `Extension ${replacement.extension.path} registers ${kind} \`${registeredName}\`, so built-in extension \`${builtinName}\` was not loaded. To use \`${builtinName}\`, run \`octocode config\` and make sure it is enabled under Built-in extensions, then disable or remove the existing extension. We recommend only having one or the other loaded at a time.`,
			});
		}
		return false;
	});
}

export function detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
	const conflicts: Array<{ path: string; message: string }> = [];

	// Track which extension registered each tool and flag
	const toolOwners = new Map<string, string>();
	const flagOwners = new Map<string, string>();

	for (const ext of extensions) {
		// Check tools
		for (const toolName of ext.tools.keys()) {
			const existingOwner = toolOwners.get(toolName);
			if (existingOwner && existingOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Tool "${toolName}" conflicts with ${existingOwner}`,
				});
			} else {
				toolOwners.set(toolName, ext.path);
			}
		}

		// Check flags
		for (const flagName of ext.flags.keys()) {
			const existingOwner = flagOwners.get(flagName);
			if (existingOwner && existingOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
				});
			} else {
				flagOwners.set(flagName, ext.path);
			}
		}
	}

	return conflicts;
}
