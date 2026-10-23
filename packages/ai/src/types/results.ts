import type { ClassifierApi, ImageApi, ProviderId } from "./ids.ts";
import type { JsonObject } from "./json.ts";
import type { ImageContent, TextContent, Usage } from "./messages.ts";

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImageApi;
	provider: ProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}

export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierScoreQuestion | ClassifierBoolQuestion;

export interface ClassifierContext {
	state: JsonObject;
	/**
	 * Images judged together with `state`. Only models whose `input` includes `"image"` accept them;
	 * other models return an error result.
	 */
	images?: ImageContent[];
	questions: Record<string, ClassifierQuestion>;
}

export interface ClassifierChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ClassifierScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

export interface ClassifierBoolAnswer {
	type: "bool";
	probability: number;
}

export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierScoreAnswer | ClassifierBoolAnswer;
export type ClassifierStopReason = "stop" | "error" | "aborted";

export interface ClassifierResult {
	api: ClassifierApi;
	provider: ProviderId;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	/** Token usage and its cost at the model's catalog price, when the service reports token counts. */
	usage?: Usage;
	stopReason: ClassifierStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}
