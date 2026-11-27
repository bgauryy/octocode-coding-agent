#!/usr/bin/env bun
/**
 * Compile the standalone `octocode` executable with Bun (`Bun.build`): one owner for `build:binary` and
 * `scripts/build/build-binaries.sh`. Run with Bun after `yarn run build`; `stage-binary.mjs` then stages what the
 * binary reads beside itself.
 *
 * Usage: bun scripts/build/compile-binary.mjs --outfile <path> [--target <bun-darwin-arm64|bun-linux-x64-baseline|...>]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "packages", "coding-agent");

/**
 * The `Bun.build` options. The image worker is an entry of its own: Bun embeds a worker only when it is one, at its
 * path under `root`. `root` is the package folder, so the worker sits at `src/utils/image-resize-worker.ts`, the path
 * `src/utils/image-resize.ts` starts it by. The project's `bunfig.toml` and `.env` are never read at run time.
 */
export function compileOptions(outfile, target) {
	return {
		entrypoints: [join(packageDir, "src", "bun", "cli.ts"), join(packageDir, "src", "utils", "image-resize-worker.ts")],
		root: packageDir,
		compile: { outfile, autoloadBunfig: false, autoloadDotenv: false, ...(target ? { target } : {}) },
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
	const outfile = value("--outfile");
	if (!outfile || typeof Bun === "undefined") {
		console.error("Usage (with Bun): bun scripts/build/compile-binary.mjs --outfile <path> [--target <bun target>]");
		process.exit(1);
	}
	const result = await Bun.build(compileOptions(resolve(outfile), value("--target")));
	for (const log of result.logs) console.error(log);
	if (!result.success) process.exit(1);
	console.log(`Compiled ${resolve(outfile)}`);
}
