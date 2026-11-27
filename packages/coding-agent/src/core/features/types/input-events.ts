/** Model, user bash and input events. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { ImageContent, Model } from "@octocodeai/octocode-ai";

// Model Events
// ============================================================================

/** `fallback`: `retry.fallbackModels` replaced a model after a usage limit, a refused credential or an outage. */
type ModelSelectSource = "set" | "cycle" | "restore" | "fallback";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
	/** `fallback`: why the previous model was replaced (`hit a usage limit`, `refused the credential`, `kept failing after retries`). */
	reason?: string;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// Input Events
// ============================================================================

export type InputSource = "interactive" | "rpc" | "feature";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
	type: "input";
	/** The input text */
	text: string;
	/** Attached images, if any */
	images?: ImageContent[];
	/** Where the input came from */
	source: InputSource;
	/** How the input will be delivered during streaming, or undefined when idle */
	streamingBehavior?: "steer" | "followUp";
}

/** A user item selected for consumption, before Codex mention expansion and persistence. */
export interface UserInputEvent extends Omit<InputEvent, "type"> {
	type: "user_input";
}
export interface UserInputEventResult {
	block?: boolean;
	additionalContext?: string[];
}

export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };
