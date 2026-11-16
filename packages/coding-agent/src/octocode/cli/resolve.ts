import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installedPackageDir, readManifest } from "@octocodeai/octocode-common/package";
import { isBunBinary } from "../../config.ts";

/** The research CLI `octocode` that `@octocodeai/octocodecode` depends on: its entry script and package version. */
export interface OctocodeCli {
	bin: string;
	version: string;
}

/**
 * The `octocode` dependency's bin: the `link:` build in a checkout, the npm version in a release. Undefined when the
 * package is not installed, its manifest is unreadable or not named `octocode`, names no bin, or the bin file is absent
 * (an unbuilt sibling checkout). The package is found by folder, whatever its `exports`, so resolution never throws.
 * `from`: the file or file URL resolution starts at; tests point it at a fixture.
 */
export function resolveOctocodeCli(from: string = import.meta.url): OctocodeCli | undefined {
	const dir = installedPackageDir(path.dirname(from.startsWith("file:") ? fileURLToPath(from) : from), "octocode");
	// An unreadable or half-written manifest is a missing CLI, as an absent one is.
	const manifest = dir === undefined ? undefined : readManifest(path.join(dir, "package.json"));
	if (dir === undefined || manifest?.name !== "octocode") return undefined;
	const entry =
		typeof manifest.bin === "string"
			? manifest.bin
			: manifest.bin && typeof manifest.bin === "object"
				? (manifest.bin as Record<string, unknown>).octocode
				: undefined;
	if (typeof entry !== "string" || typeof manifest.version !== "string") return undefined;
	const bin = path.resolve(dir, entry);
	return existsSync(bin) ? { bin, version: manifest.version } : undefined;
}

/** The JavaScript runtime that runs the CLI's entry script: this process's own, unless it is a compiled binary. */
export function cliRuntime(): string {
	return isBunBinary ? "node" : process.execPath;
}
