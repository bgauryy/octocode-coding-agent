/**
 * Path labels for loaded resources: home-relative and cwd-relative paths, package-relative paths, and the short
 * unique labels of the compact startup listing.
 */

import * as path from "node:path";
import type { SourceInfo } from "../../../core/source-info.ts";
import { parseGitUrl } from "../../../utils/git.ts";
import { getCwdRelativePath } from "@octocodeai/octocode-common/paths";
import type { InteractiveModeHost } from "./host.ts";
import { isPackageSource } from "./resource-groups.ts";
import type { SourcedPath } from "./types.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";

/** Interactive-mode members used by the resource path labels. */
type ResourcePathsHost = Pick<
	InteractiveModeHost,
	| "getCompactDisplayPathSegments"
	| "getCompactFeatureLabel"
	| "getCompactNonPackageFeatureLabel"
	| "getCompactPathLabel"
	| "getShortPath"
	| "sessionManager"
>;

export function formatDisplayPath(p: string): string {
	return homeTilde(p);
}

export function formatFeatureDisplayPath(_host: ResourcePathsHost, path: string): string {
	let result = formatDisplayPath(path);
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

	return formatDisplayPath(absolutePath);
}

/**
 * Get a short path relative to the package root for display.
 */
export function getShortPath(_host: ResourcePathsHost, fullPath: string, sourceInfo?: SourceInfo): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
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

	return formatDisplayPath(fullPath);
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

export function getCompactFeatureLabel(host: ResourcePathsHost, resourcePath: string, sourceInfo?: SourceInfo): string {
	if (!isPackageSource(sourceInfo)) {
		return host.getCompactPathLabel(resourcePath, sourceInfo);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
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

export function getCompactDisplayPathSegments(_host: ResourcePathsHost, resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

export function getCompactNonPackageFeatureLabel(
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

export function getCompactFeatureLabels(host: ResourcePathsHost, features: SourcedPath[]): string[] {
	const nonPackageFeatures = features
		.map((feature) => {
			const segments = host.getCompactDisplayPathSegments(feature.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: feature.path,
				sourceInfo: feature.sourceInfo,
				segments,
			};
		})
		.filter((feature) => !isPackageSource(feature.sourceInfo));

	return features.map((feature) => {
		if (isPackageSource(feature.sourceInfo)) {
			return host.getCompactFeatureLabel(feature.path, feature.sourceInfo);
		}

		const nonPackageIndex = nonPackageFeatures.findIndex((item) => item.path === feature.path);
		if (nonPackageIndex === -1) {
			return host.getCompactPathLabel(feature.path, feature.sourceInfo);
		}

		return host.getCompactNonPackageFeatureLabel(feature.path, nonPackageIndex, nonPackageFeatures);
	});
}
