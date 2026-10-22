import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

/** Project MCP files, lowest precedence first. All require project trust. */
export function projectMcpConfigPaths(cwd: string): string[] {
	return [
		...new Set([
			join(cwd, ".pi", "mcp.json"),
			join(cwd, ".mcp.json"),
			join(cwd, ".agents", "mcp.json"),
			join(cwd, CONFIG_DIR_NAME, "mcp.json"),
		]),
	];
}
