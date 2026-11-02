// The package's public API is the CLI and RPC: `main`, the RPC server and its typed client, and print mode.
export { VERSION } from "./config.ts";
export { main } from "./main.ts";
export {
	type JsonAgentSessionEvent,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcEvent,
	type RpcEventListener,
	type RpcExtensionUIDismiss,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	runPrintMode,
	runRpcMode,
} from "./modes/index.ts";
