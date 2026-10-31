import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { isUnderPath } from "../../../../common/src/paths.ts";
import type { PathMetadata } from "../package-manager.ts";
import { createSourceInfo, getSyntheticPathSource, isSyntheticPath, type SourceInfo } from "../source-info.ts";

/** The roots that classify a resource path as user or project scoped. */
export interface ResourceRoots {
	cwd: string;
	agentDir: string;
}

export function findSourceInfoForPath(
	roots: ResourceRoots,
	resourcePath: string,
	extraSourceInfos?: Map<string, SourceInfo>,
	metadataByPath?: Map<string, PathMetadata>,
): SourceInfo | undefined {
	if (!resourcePath) {
		return undefined;
	}

	if (isSyntheticPath(resourcePath)) {
		return getDefaultSourceInfoForPath(roots, resourcePath);
	}

	const normalizedResourcePath = resolve(resourcePath);
	if (extraSourceInfos) {
		for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
			if (isUnderPath(normalizedResourcePath, sourcePath)) {
				return { ...sourceInfo, path: resourcePath };
			}
		}
	}

	if (metadataByPath) {
		const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
		if (exact) {
			return createSourceInfo(resourcePath, exact);
		}

		for (const [sourcePath, metadata] of metadataByPath.entries()) {
			if (isUnderPath(normalizedResourcePath, sourcePath)) {
				return createSourceInfo(resourcePath, metadata);
			}
		}
	}

	return undefined;
}

export function getDefaultSourceInfoForPath(roots: ResourceRoots, filePath: string): SourceInfo {
	const syntheticSource = getSyntheticPathSource(filePath);
	if (syntheticSource) {
		return {
			path: filePath,
			source: syntheticSource,
			scope: "temporary",
			origin: "top-level",
		};
	}

	const normalizedPath = resolve(filePath);
	const agentRoots = [
		join(roots.agentDir, "skills"),
		join(roots.agentDir, "prompts"),
		join(roots.agentDir, "themes"),
		join(roots.agentDir, "extensions"),
	];
	const projectRoots = [
		join(roots.cwd, CONFIG_DIR_NAME, "skills"),
		join(roots.cwd, CONFIG_DIR_NAME, "prompts"),
		join(roots.cwd, CONFIG_DIR_NAME, "themes"),
		join(roots.cwd, CONFIG_DIR_NAME, "extensions"),
	];

	for (const root of agentRoots) {
		if (isUnderPath(normalizedPath, root)) {
			return {
				path: filePath,
				source: "local",
				scope: "user",
				origin: "top-level",
				baseDir: root,
			};
		}
	}

	for (const root of projectRoots) {
		if (isUnderPath(normalizedPath, root)) {
			return {
				path: filePath,
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: root,
			};
		}
	}

	return {
		path: filePath,
		source: "local",
		scope: "temporary",
		origin: "top-level",
		baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
	};
}
