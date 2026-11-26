/**
 * Stage the MCP servers a compiled binary runs from its own dependencies (`install.hostDependency` in the default
 * servers of `default_mcp_config.json`), with their production dependencies for its platform, into `<binary folder>/node_modules/`, where the binary
 * resolves them (`mcp/src/host-dependency.ts`) and the server finds its language server (`tsgo`). Each is
 * copied as `npm pack` would publish it from the package the coding agent resolves: in development the linked
 * sibling build, whose version may not be on npm yet; in a release checkout the installed one. The binary then starts
 * its research server without an npm install or a download, offline too. Used by `stage-binary.mjs`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The npm package of each default server (`servers` in the default MCP config file) the host runs from its own dependencies. */
export function hostMcpPackages(defaultConfig) {
	return Object.values(JSON.parse(readFileSync(defaultConfig, "utf8")).servers)
		.filter((preset) => preset.install?.hostDependency === true)
		.map((preset) => String(preset.install.npm))
		.sort((a, b) => a.localeCompare(b));
}

/** The files `npm pack` would publish from the package in `dir` (its `files`, ignores and always-included files). */
function npmPackFiles(dir) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const out = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" });
	return JSON.parse(out)[0].files.map((file) => file.path);
}

/** Copies those files of the package in `dir` into `target`, modes kept (a native binary stays executable). */
function stagePackedPackage(dir, target, listFiles = npmPackFiles) {
	rmSync(target, { recursive: true, force: true });
	for (const file of listFiles(dir)) {
		mkdirSync(dirname(join(target, file)), { recursive: true });
		cpSync(join(dir, file), join(target, file), { dereference: true });
	}
}

/** The folder of package `name` as `from` resolves it, or undefined when it does not resolve. */
function resolvedDir(from, name) {
	try {
		return realpathSync(dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`)));
	} catch {
		return undefined;
	}
}

/** The `os`, `cpu` and `libc` of a binary platform, as npm manifests name them: Bun's Linux targets are glibc. */
const NPM_TARGET = {
	"darwin-arm64": { os: "darwin", cpu: "arm64" },
	"darwin-x64": { os: "darwin", cpu: "x64" },
	"linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
	"linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
	"windows-x64": { os: "win32", cpu: "x64" },
	"windows-arm64": { os: "win32", cpu: "arm64" },
};

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
/** Whether a manifest's `os`, `cpu` and `libc` (each absent: any) admit the target. */
const fits = (manifest, target) =>
	(!manifest.os || manifest.os.includes(target.os)) &&
	(!manifest.cpu || manifest.cpu.includes(target.cpu)) &&
	(!manifest.libc || !target.libc || manifest.libc.includes(target.libc));
/** An uninstalled optional package named for the target (`<name>-linux-x64`, `-linux-x64-gnu`, `-win32-x64-msvc`). */
const namedFor = (name, target) => new RegExp(`-${target.os}-${target.cpu}(-gnu|-msvc)?$`).test(name);
/** A file the manifest's `files` names that is not here: a platform package whose binary was not built on this machine. */
const unbuilt = (dir, manifest) =>
	(manifest.files ?? []).some((entry) => !/[*?]/.test(entry) && !existsSync(join(dir, entry)));

/**
 * Stages package `name` as `from` resolves it, then its production dependencies and, of its optional ones, those built
 * for the target (`os`/`cpu`; `@typescript/native-preview` ships `tsgo` that way). A required package that does not
 * resolve fails the build; the target's optional package missing here (another platform's) is reported.
 */
function stageWithDependencies(name, from, outDir, target, listFiles, result) {
	if (result.staged.includes(name)) return;
	const dir = resolvedDir(from, name);
	if (!dir) throw new Error(`${name} does not resolve from ${from}; install the workspace first.`);
	const manifest = manifestOf(dir);
	stagePackedPackage(dir, join(outDir, "node_modules", ...name.split("/")), listFiles);
	result.staged.push(name);
	for (const dependency of Object.keys(manifest.dependencies ?? {}))
		stageWithDependencies(dependency, dir, outDir, target, listFiles, result);
	for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
		const found = resolvedDir(dir, dependency);
		const optional = found && manifestOf(found);
		if (!(optional ? fits(optional, target) : namedFor(dependency, target))) continue;
		if (optional && !unbuilt(found, optional))
			stageWithDependencies(dependency, dir, outDir, target, listFiles, result);
		else result.missing.push(dependency);
	}
}

/**
 * Stages every host-dependency server with its production dependencies for `platform`: `octocode-mcp` brings its
 * native binary and TypeScript's `tsgo` as per-platform optional packages. A server the coding agent does not resolve
 * fails the build. A platform package that is not built or installed here (another platform's) is reported: that
 * binary's server fetches its native binary on first start, and goes without that language server.
 */
export function stageHostMcpServers(outDir, platform, { packageDir, defaultConfig, listFiles = npmPackFiles }) {
	const result = { staged: [], missing: [] };
	for (const name of hostMcpPackages(defaultConfig))
		stageWithDependencies(name, packageDir, outDir, NPM_TARGET[platform], listFiles, result);
	return result;
}
