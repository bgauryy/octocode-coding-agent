import { GEMINI_LATEST_ALIAS } from "./google-thinking-format.ts";

export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

export function requiresToolCallId(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || (major !== undefined && major >= 3);
}

const LATEST_ALIAS_MAJOR = 3;
export function getGeminiMajorVersion(modelId: string): number | undefined {
	const id = modelId.toLowerCase();
	if (GEMINI_LATEST_ALIAS.test(id)) return LATEST_ALIAS_MAJOR;
	const match = id.match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

export function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) return geminiMajorVersion >= 3;
	return true;
}
