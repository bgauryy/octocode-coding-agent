/**
 * The host application's own copy of a server package (`install.hostDependency`): the package the host's `package.json`
 * lists in `dependencies`, resolved from the folder the host is installed in (`McpIdentityPort.packageDir`), never from
 * this source tree or the project. In development that is the linked sibling build; in a release, the npm version the
 * published manifest pins.
 */

import fs from "node:fs";
import path from "node:path";
import type { McpInstallConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { installedPackageDir, type PackageManifest, readManifest } from "../../common/src/package.ts";

/** The bin file the manifest names: `spec.bin`, else its only bin, else the one named like the package. */
export function binOf(manifest: PackageManifest, spec: McpInstallConfig): string | undefined {
	const { bin } = manifest;
	if (typeof bin === "string")
		return spec.bin === undefined || spec.bin === spec.npm.split("/").pop() ? bin : undefined;
	if (!bin || typeof bin !== "object") return undefined;
	const bins = bin as Record<string, unknown>;
	const names = Object.keys(bins);
	const name = spec.bin ?? (names.length === 1 ? names[0] : spec.npm.split("/").pop());
	const file = name === undefined ? undefined : bins[name];
	return typeof file === "string" ? file : undefined;
}

/** What the host's dependency on a package resolved to. */
export type HostDependencyBin =
	/** The bin file exists. */
	| { bin: string }
	/** The package resolved, but its bin file is absent: an unbuilt linked package. */
	| { missing: string; dir: string };

/**
 * The bin of `spec.npm` as the host installed it, or undefined when the host does not list the package in its
 * `dependencies` or it does not resolve from `packageDir`.
 */
export function hostDependencyBin(spec: McpInstallConfig, packageDir: string): HostDependencyBin | undefined {
	const dependencies = readManifest(path.join(packageDir, "package.json"))?.dependencies;
	if (!dependencies || typeof dependencies !== "object" || !Object.hasOwn(dependencies, spec.npm)) return undefined;
	const dir = installedPackageDir(packageDir, spec.npm);
	const manifest = dir === undefined ? undefined : readManifest(path.join(dir, "package.json"));
	if (dir === undefined || manifest?.name !== spec.npm) return undefined;
	const file = binOf(manifest, spec);
	if (!file) return undefined;
	const bin = path.resolve(dir, file);
	if (!fs.existsSync(bin)) return { missing: bin, dir };
	return { bin };
}
