import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { workspaceRoot } from "../../utils/git-repository.ts";
import { browserMcpEscalations } from "./browser-mcp-escalations.ts";

/**
 * What a browser MCP call does beyond the generic MCP class (`browserMcpEscalations`), for
 * `cwd`, the folder the browser server runs in: `control` lines, each a `browser.control` ask, `cookies` lines, each a `browser.cookies` ask, and `outside`, the
 * upload paths outside the workspace (symlinks resolved), an `upload.outside` ask. An upload from inside the workspace
 * is an ordinary MCP call. A session with no workspace (started in the home folder or above) has every path outside.
 */
export function browserEscalations(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): { control: string[]; cookies: string[]; outside: string[] } {
	const found = browserMcpEscalations(toolName, input);
	const control = found.filter((each) => each.kind === "control").map((each) => each.what);
	const cookies = found.filter((each) => each.kind === "cookies").map((each) => each.what);
	const uploads = found.flatMap((each) => (each.kind === "upload" && each.path ? [each.path] : []));
	if (uploads.length === 0) return { control, cookies, outside: [] };
	const workspace = workspaceRoot(cwd);
	const root = workspace === undefined ? undefined : canonicalPath(workspace);
	const outside = uploads
		.map((file) => canonicalPath(path.resolve(cwd, file)))
		.filter((file) => root === undefined || !isWithin(file, root));
	return { control, cookies, outside: [...new Set(outside)] };
}
