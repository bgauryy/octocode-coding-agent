/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

export { convertMessages, requiresToolCallId } from "./google-shared/messages.ts";
export {
	mapStopReason,
	mapStopReasonString,
	normalizeGoogleUsage,
	retryGoogleRequest,
} from "./google-shared/response.ts";
export { isThinkingPart, retainThoughtSignature } from "./google-shared/signatures.ts";
export { type GoogleStreamAdapter, streamGoogle } from "./google-shared/stream.ts";
export {
	type GoogleApiThinkingLevel,
	getDisabledGoogleThinkingConfig,
	type ResolvedGoogleThinkingLevel,
	resolveGoogleThinkingLevel,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared/thinking.ts";
export {
	convertTools,
	mapToolChoice,
	resolveGoogleFunctionCallingMode,
	supportsGoogleStrictToolSampling,
} from "./google-shared/tools.ts";
