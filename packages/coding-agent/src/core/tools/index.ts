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

import type { BashToolOptions } from "./bash.ts";

/** Options of the core tools. `bash` is the only core tool; every other built-in tool belongs to the native feature. */
export interface ToolsOptions {
	bash?: BashToolOptions;
}
