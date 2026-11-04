/**
 * The entry of the one-file Node bundle (`dist/bundle/octocode.js`): the package exports, the MCP subpaths, the commands
 * and the image worker. The small launchers beside it choose a command. Everything that loads the session runtime stays
 * behind a dynamic import, so importing this file starts nothing and each command keeps its own start order.
 */
import { isMainThread, workerData } from "node:worker_threads";
import type { PrintModeOptions } from "./modes/print-mode.ts";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { IMAGE_RESIZE_WORKER_DATA } from "./utils/image-resize-core.ts";

export { VERSION } from "./config.ts";
export { RpcClient } from "./modes/rpc/rpc-client.ts";
export * from "../../mcp/src/client/index.ts";
export * from "../../mcp/src/client/oauth/index.ts";

export async function main(args: string[]): Promise<void> {
	return (await import("./main.ts")).main(args);
}

export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	return (await import("./modes/print-mode.ts")).runPrintMode(runtimeHost, options);
}

export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	return (await import("./modes/rpc/rpc-mode.ts")).runRpcMode(runtimeHost);
}

export const runCli = () => import("./cli.ts");
export const runApiCli = () => import("./octocode/api/cli.ts");
export const runRpcEntry = () => import("./rpc-entry.ts");

// `resizeImage` starts this same file as its worker.
if (!isMainThread && workerData === IMAGE_RESIZE_WORKER_DATA) await import("./utils/image-resize-worker.ts");
