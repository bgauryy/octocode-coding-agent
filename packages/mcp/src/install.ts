/**
 * Installs a server entry's npm package (`install` in its config) once into `<agentDir>/mcp/servers/<name>/`, and
 * launches its bin with node. The install runs npm with `--ignore-scripts` under a file lock and is skipped when the
 * installed version already matches. A failure leaves the server out for the session with one warning; nothing falls
 * back to `npx`, which could start a package from the project's `node_modules`. With `hostDependency`, the host's own
 * copy of the package runs instead when it resolves (`host-dependency.ts`), and the install is the fallback.
 */

import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { spawnProcess, waitForChildProcess } from "../../common/src/child-process.ts";
import { withFileWriteLock } from "../../common/src/file-write-lock.ts";
import type { McpServerEntry } from "./config.ts";
import { binOf, hostDependencyBin } from "./host-dependency.ts";
import { readManifest } from "../../common/src/package.ts";
import { hostIdentity, hostPaths } from "./host.ts";
import type { McpInstallConfig } from "@octocodeai/octocode-contracts/mcp-server";
import { warnOnce } from "./warnings.ts";

/** Runs npm with `args` in `cwd`; rejects with a message naming the cause when npm is missing or fails. */
export type McpNpmRunner = (args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<void>;

export interface McpInstallOptions {
	/** Default: `hostPaths().agentDir()`. */
	agentDir?: string;
	/** Default: the `npm` on PATH. */
	runNpm?: McpNpmRunner;
	/** Where `hostDependency` packages resolve from. Default: `hostIdentity().packageDir()`. */
	packageDir?: string;
	signal?: AbortSignal;
}

/** Install failures of this process, by folder and version: the server stays out until the next process. */
const failures = new Map<string, Error>();

const defaultNpm: McpNpmRunner = async (args, { cwd, signal }) => {
	const child = spawnProcess(process.platform === "win32" ? "npm.cmd" : "npm", args, {
		cwd,
		stdio: ["ignore", "ignore", "pipe"],
		...(signal ? { signal } : {}),
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2000);
	});
	const spawnError = new Promise<never>((_resolve, reject) => child.once("error", reject));
	const code = await Promise.race([waitForChildProcess(child, signal), spawnError]);
	if (code !== 0) throw new Error(`npm exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
};

/** The folder a server's package is installed in. */
export const mcpInstallDir = (agentDir: string, name: string): string =>
	path.join(agentDir, "mcp", "servers", name.replace(/[^A-Za-z0-9_-]/g, "_"));

/**
 * The absolute path of the installed bin of `spec` for server `name`, installing the package first when the folder
 * does not hold that version. Concurrent sessions wait on one lock; the second finds the version installed.
 */
export async function installMcpServer(
	name: string,
	spec: McpInstallConfig,
	options: McpInstallOptions = {},
): Promise<string> {
	const dir = mcpInstallDir(options.agentDir ?? hostPaths().agentDir(), name);
	const key = `${dir}\0${spec.npm}@${spec.version}`;
	const failed = failures.get(key);
	if (failed) throw failed;
	const manifestFile = path.join(dir, "node_modules", ...spec.npm.split("/"), "package.json");
	const installed = (): string | undefined => {
		const manifest = readManifest(manifestFile);
		if (manifest?.version !== spec.version) return undefined;
		const bin = binOf(manifest, spec);
		if (!bin) throw new Error(`${spec.npm}@${spec.version} has no bin${spec.bin ? ` named "${spec.bin}"` : ""}`);
		return path.resolve(path.dirname(manifestFile), bin);
	};
	try {
		const ready = installed();
		if (ready) return ready;
		fs.mkdirSync(dir, { recursive: true });
		return await withFileWriteLock(
			path.join(dir, "install"),
			async (_target, assertHeld) => {
				const done = installed();
				if (done) return done;
				const run = options.runNpm ?? defaultNpm;
				const args = ["install", "--prefix", dir, "--no-save", "--ignore-scripts", `${spec.npm}@${spec.version}`];
				await run(args, { cwd: dir, ...(options.signal ? { signal: options.signal } : {}) });
				assertHeld();
				const bin = installed();
				if (!bin) throw new Error(`npm finished, but ${manifestFile} does not hold version ${spec.version}`);
				return bin;
			},
			options.signal,
		);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const failure = new Error(
			`MCP server "${name}" is left out: installing ${spec.npm}@${spec.version} into ${dir} failed: ${errorMessage(error)}`,
		);
		failures.set(key, failure);
		warnOnce(failure.message);
		throw failure;
	}
}

/**
 * The host's own build of `spec` for server `name`, or undefined to install it instead. A package that resolves without
 * its bin file (an unbuilt linked package) warns, naming the build, before the install fallback.
 */
function hostDependencyLaunch(name: string, spec: McpInstallConfig, options: McpInstallOptions): string | undefined {
	if (!spec.hostDependency) return undefined;
	const found = hostDependencyBin(spec, options.packageDir ?? hostIdentity().packageDir());
	if (!found) return undefined;
	if ("bin" in found) return found.bin;
	warnOnce(
		`MCP server "${name}": ${spec.npm} at ${found.dir} is not built (${found.missing} is missing); run \`yarn build\` in ${found.dir}. Installing ${spec.npm}@${spec.version} from npm instead.`,
	);
	return undefined;
}

/**
 * The entry as it launches: with `install`, node running the host's own copy of the package (`hostDependency`) or else
 * the installed bin, then the configured `args`.
 */
export async function resolveInstalledLaunch(
	entry: McpServerEntry,
	options: McpInstallOptions = {},
): Promise<McpServerEntry> {
	const { config } = entry;
	if ("url" in config || !config.install) return entry;
	const bin =
		hostDependencyLaunch(entry.name, config.install, options) ??
		(await installMcpServer(entry.name, config.install, options));
	// A standalone binary's execPath is the binary itself, not node.
	const command = hostIdentity().isBunBinary() ? "node" : process.execPath;
	return { ...entry, config: { ...config, command, args: [bin, ...(config.args ?? [])] } };
}

/** Forget this process's install failures (tests). */
export function resetMcpInstallFailures(): void {
	failures.clear();
}
