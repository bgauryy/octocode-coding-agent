import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../../config.ts";
import { sessionsRoot } from "../../shared/home.ts";
import { findManifest, packageRoot } from "../../shared/package.ts";
import type { Launch } from "../client.ts";

/** The npm package of the server this extension runs. */
const MCP_PACKAGE = "octocode-mcp";

/** The `octocode-mcp` range this package's `package.json` depends on (the one source of the version this extension runs). */
function octocodeMcpRange(): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const range = manifest.dependencies?.[MCP_PACKAGE];
	if (!range) throw new Error("package.json has no octocode-mcp dependency");
	return range;
}

/**
 * The octocode-mcp releases this extension runs, as an npx spec: the `package.json` dependency range, so installing or
 * updating the extension and the npx fallback fetch the same newest compatible server; in this monorepo `dev setup`
 * resolves the dependency to the workspace build (`packages/octocode-mcp`).
 */
export const OCTOCODE_MCP_SPEC = `${MCP_PACKAGE}@${octocodeMcpRange()}`;

/**
 * The folders the server's local readers may reach: the workspace, the session folders (spilled output, bash logs,
 * archives) and loaded skills. Not Octocode's home itself: its trust store, agent database and credentials stay out of
 * reach of a read-only tool that asks no permission.
 */
export function octocodeAllowedPaths(
	cwd: string,
	skillDirectories: readonly string[] = [],
	env: NodeJS.ProcessEnv = process.env,
): string {
	return [...new Set([cwd, sessionsRoot(env), ...skillDirectories])].join(",");
}

/**
 * The server process: the installed octocode-mcp bin under this Node, else (trusted projects only) the newest npm release through npx. Project
 * configuration is honored only in a trusted project: an untrusted project cannot make the server launch the language
 * servers its `.octocode/lsp-servers.json` names, whatever the host environment says.
 */
export function octocodeLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	entry = octocodeMcpEntry(),
	skillDirectories: readonly string[] = [],
	projectTrusted = true,
): Launch {
	// Loaded skills may live outside the workspace; their references resolve inside the same skill directories.
	// Tokens (GITHUB_TOKEN, …) need no forwarding: the server inherits this process's environment.
	if (!entry && OCTOCODE_MCP_SPEC.includes("@file:"))
		throw new Error(
			"The local octocode-mcp build is missing. Build the linked package before starting Octocode research.",
		);
	// The npx fallback resolves the server from the registry, or from a `node_modules` in the working directory: only a
	// trusted project may be that directory.
	if (!entry && !projectTrusted)
		throw new Error(
			"octocode-mcp is not installed next to Octocode, and the npx fallback runs only in a trusted project (it could start a package from the project's node_modules). Reinstall Octocode, or trust this project.",
		);
	const command = entry
		? { command: isBunBinary ? "node" : process.execPath, args: [entry] }
		: { command: "npx", args: ["-y", OCTOCODE_MCP_SPEC] };
	return {
		...command,
		cwd,
		env: {
			WORKSPACE_ROOT: cwd,
			ALLOWED_PATHS: octocodeAllowedPaths(cwd, skillDirectories, env),
			...(projectTrusted ? {} : { OCTOCODE_TRUST_PROJECT_LSP_CONFIG: "false" }),
		},
	};
}

/**
 * Where the installed octocode-mcp package starts: its entry (a release's `exports` hide package.json, so walk up from
 * it), else its package.json (a linked local build may declare only `bin`, which the entry lookup cannot resolve).
 */
function octocodeMcpStart(): string {
	try {
		return fileURLToPath(import.meta.resolve(MCP_PACKAGE));
	} catch {
		return createRequire(import.meta.url).resolve(`${MCP_PACKAGE}/package.json`);
	}
}

/** Absolute path of the bundled octocode-mcp bin. */
function octocodeMcpEntry(): string | undefined {
	try {
		const found = findManifest(path.dirname(octocodeMcpStart()), MCP_PACKAGE, 4);
		const bin = typeof found?.manifest.bin === "string" ? found.manifest.bin : found?.manifest.bin?.[MCP_PACKAGE];
		return found && bin ? path.join(found.dir, bin) : undefined;
	} catch {
		// Not installed next to the extension.
	}
	return undefined;
}
