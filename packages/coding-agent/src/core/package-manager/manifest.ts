import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "@octocodeai/octocode-common/json";
import type { ResourceType } from "./resource-types.ts";
import { RESOURCE_TYPES } from "./resource-types.ts";

/** The resource entries a package declares under the `octocode` key of its `package.json`. */
export type PackageManifest = Partial<Record<ResourceType, string[]>>;

/**
 * The `octocode` manifest of `packageJsonPath`, or null when the file is missing or declares none. A file that exists
 * but cannot be read or parsed throws, naming the file. Only the `octocode` key counts: other tools' keys, Pi's `pi`
 * key included, declare code that never loads here.
 */
export function readPackageManifest(packageJsonPath: string): PackageManifest | null {
	try {
		const pkg: unknown = readJsonFile(packageJsonPath);
		if (!isRecord(pkg)) return null;
		const config = pkg.octocode;
		if (!isRecord(config)) return null;

		const manifest: PackageManifest = {};
		for (const field of RESOURCE_TYPES) {
			const entries = config[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) manifest[field] = entries;
		}
		return manifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`Cannot read the package manifest ${packageJsonPath}`, { cause: error });
	}
}
