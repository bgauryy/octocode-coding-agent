export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BashToolOptions } from "./bash.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

/** Options of the core tools. `bash` is the only core tool; every other built-in tool belongs to the native feature. */
export interface ToolsOptions {
	bash?: BashToolOptions;
}
