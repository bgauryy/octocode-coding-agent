/**
 * Path labels for loaded resources: home-relative and cwd-relative paths, package-relative paths, and the short
 * unique labels of the compact startup listing.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { SourceInfo } from "../../../core/source-info.ts";
import { parseGitUrl } from "../../../utils/git.ts";
import { getCwdRelativePath } from "../../../utils/paths.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the resource path labels. */
export type ResourcePathsHost = Pick<
	InteractiveModeHost,
	| "formatDisplayPath"
	| "getCompactDisplayPathSegments"
	| "getCompactExtensionLabel"
	| "getCompactNonPackageExtensionLabel"
	| "getCompactPackageSourceLabel"
	| "getCompactPathLabel"
	| "getShortPath"
	| "isPackageSource"
	| "sessionManager"
>;

export function formatDisplayPath(p: string): string {
	const home = os.homedir();
	let result = p;

	// Replace home directory with ~
	if (result.startsWith(home)) {
		result = `~${result.slice(home.length)}`;
	}

	return result;
}

export function formatExtensionDisplayPath(host: ResourcePathsHost, path: string): string {
	let result = host.formatDisplayPath(path);
	result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
	return result;
}

export function formatContextPath(host: ResourcePathsHost, p: string): string {
	const cwd = path.resolve(host.sessionManager.getCwd());
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
	const relativePath = getCwdRelativePath(absolutePath, cwd);
	if (relativePath !== undefined) {
		return relativePath;
	}

	return host.formatDisplayPath(absolutePath);
}

/**
 * Get a short path relative to the package root for display.
 */
export function getShortPath(host: ResourcePathsHost, fullPath: string, sourceInfo?: SourceInfo): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && host.isPackageSource(sourceInfo)) {
		const normalizedBaseDir = baseDir.replace(/\\/g, "/");
		const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
		if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
			return path.posix.relative(normalizedBaseDir, normalizedFullPath);
		}

		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2];
	}

	const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1];
	}

	return host.formatDisplayPath(fullPath);
}

export function getCompactPathLabel(host: ResourcePathsHost, resourcePath: string, sourceInfo?: SourceInfo): string {
	const shortPath = host.getShortPath(resourcePath, sourceInfo);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1];
	}
	return shortPath;
}

export function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

export function getCompactExtensionLabel(
	host: ResourcePathsHost,
	resourcePath: string,
	sourceInfo?: SourceInfo,
): string {
	if (!host.isPackageSource(sourceInfo)) {
		return host.getCompactPathLabel(resourcePath, sourceInfo);
	}

	const sourceLabel = host.getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return host.getCompactPathLabel(resourcePath, sourceInfo);
	}

	const shortPath = host.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

export function getCompactDisplayPathSegments(host: ResourcePathsHost, resourcePath: string): string[] {
	return host
		.formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

export function getCompactNonPackageExtensionLabel(
	host: ResourcePathsHost,
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return host.getCompactPathLabel(resourcePath);
	}

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) {
				return true;
			}
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});

		if (isUnique) {
			return candidate;
		}
	}

	return segments.join("/");
}

export function getCompactExtensionLabels(
	host: ResourcePathsHost,
	extensions: Array<{ path: string; sourceInfo?: SourceInfo }>,
): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = host.getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !host.isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (host.isPackageSource(extension.sourceInfo)) {
			return host.getCompactExtensionLabel(extension.path, extension.sourceInfo);
		}

		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) {
			return host.getCompactPathLabel(extension.path, extension.sourceInfo);
		}

		return host.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
	});
}
