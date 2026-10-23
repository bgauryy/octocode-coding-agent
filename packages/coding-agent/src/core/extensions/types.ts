/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@octocodeai/octocode-agent-core";
export type { ExecOptions, ExecResult } from "../exec.ts";
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";
export type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
export type * from "./types/agent-events.ts";
export type * from "./types/api.ts";
export type * from "./types/context.ts";
export type * from "./types/events.ts";
export type * from "./types/input-events.ts";
export type * from "./types/provider.ts";
export type * from "./types/rendering.ts";
export type * from "./types/runtime.ts";
export type * from "./types/session-events.ts";
export * from "./types/tool-events.ts";
export * from "./types/tools.ts";
export type * from "./types/ui.ts";
