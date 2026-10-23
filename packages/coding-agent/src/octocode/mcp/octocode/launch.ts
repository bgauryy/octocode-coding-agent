import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../../config.ts";
import { octocodeHome } from "../../shared/home.ts";
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

/** The server process: the installed octocode-mcp bin under this Node, else the newest npm release through npx. */
export function octocodeLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	entry = octocodeMcpEntry(),
	skillDirectories: readonly string[] = [],
): Launch {
	// Loaded skills may live outside the workspace; their references resolve inside the same skill directories.
	// Tokens (GITHUB_TOKEN, …) need no forwarding: the server inherits this process's environment.
	const allowed = [...new Set([cwd, octocodeHome(env), ...skillDirectories])].join(",");
	if (!entry && OCTOCODE_MCP_SPEC.includes("@file:"))
		throw new Error(
			"The local octocode-mcp build is missing. Build the linked package before starting Octocode research.",
		);
	const command = entry
		? { command: isBunBinary ? "node" : process.execPath, args: [entry] }
		: { command: "npx", args: ["-y", OCTOCODE_MCP_SPEC] };
	return { ...command, cwd, env: { WORKSPACE_ROOT: cwd, ALLOWED_PATHS: allowed } };
}

/** Absolute path of the bundled octocode-mcp bin (its `exports` hide package.json, so walk up from the entry). */
function octocodeMcpEntry(): string | undefined {
	try {
		const found = findManifest(path.dirname(fileURLToPath(import.meta.resolve(MCP_PACKAGE))), MCP_PACKAGE, 4);
		const bin = typeof found?.manifest.bin === "string" ? found.manifest.bin : found?.manifest.bin?.[MCP_PACKAGE];
		return found && bin ? path.join(found.dir, bin) : undefined;
	} catch {
		// Not installed next to the extension.
	}
	return undefined;
}
