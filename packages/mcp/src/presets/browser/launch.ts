import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { hostIdentity } from "../../host.ts";
import { BROWSER_BIN, BROWSER_PACKAGE } from "../../../../common/src/mcp-names.ts";

export interface BrowserLaunch {
	command: string;
	args: string[];
	cwd: string;
}

/** Absolute path of the installed browser package's bin, or undefined when it is not installed next to Octocode. */
export function browserMcpEntry(): string | undefined {
	try {
		const manifestPath = createRequire(import.meta.url).resolve(`${BROWSER_PACKAGE}/package.json`);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[BROWSER_BIN];
		return bin ? path.join(path.dirname(manifestPath), bin) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The browser server process: the installed package bin under this Node, started in the workspace. The server keeps its
 * captures under `<cwd>/.octocode/octocode-chrome-devtools/`, and its continuations resolve relative to that cwd.
 */
export function browserLaunch(cwd: string, entry = browserMcpEntry()): BrowserLaunch {
	if (!entry)
		throw new Error(
			`${BROWSER_PACKAGE} is not installed next to Octocode. Reinstall Octocode to restore the browser MCP server.`,
		);
	return { command: hostIdentity().isBunBinary() ? "node" : process.execPath, args: [entry], cwd };
}
