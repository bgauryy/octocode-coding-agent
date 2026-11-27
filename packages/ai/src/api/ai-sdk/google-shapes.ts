import type { GoogleUsageMetadata } from "./google-usage.ts";

export interface GooglePart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: { data?: string; mimeType?: string };
	fileData?: { fileUri?: string; mimeType?: string };
	executableCode?: { language?: string; code?: string };
	codeExecutionResult?: { outcome?: string; output?: string };
	audioTranscription?: { text?: string };
	toolCall?: { id?: string; toolType?: string; args?: unknown };
	toolResponse?: { id?: string; toolType?: string; response?: unknown };
	functionCall?: { id?: string; name?: string; args?: unknown };
	functionResponse?: { id?: string; name?: string; response?: unknown; parts?: unknown[]; willContinue?: boolean };
}
interface Source {
	uri?: string;
	title?: string;
}
export interface GoogleCandidate {
	content?: { parts?: GooglePart[] };
	finishReason?: string;
	citationMetadata?: { citations?: { uri?: string; title?: string; startIndex?: number; endIndex?: number }[] };
	groundingMetadata?: {
		groundingChunks?: { web?: Source; retrievedContext?: Source; maps?: Source }[];
		groundingSupports?: {
			groundingChunkIndices?: number[];
			segment?: { text?: string; startIndex?: number; endIndex?: number };
		}[];
	};
}
export interface GoogleChunk {
	usageMetadata?: GoogleUsageMetadata;
	candidates?: GoogleCandidate[];
}
