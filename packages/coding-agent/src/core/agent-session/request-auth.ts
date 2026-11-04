/** Request authentication for the session's own model calls: agent requests and summaries. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { type AuthResult, type Model, type ProviderHeaders, streamSimple } from "@octocodeai/octocode-ai/compat";
import { formatAuthExpiredMessage, formatNoApiKeyFoundMessage } from "../auth-guidance.ts";
import { convertToLlm } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { isVirtualModel } from "../virtual-models.ts";
import type { SessionPublic } from "./host.ts";

export interface RequestAuth {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

async function getRequiredRequestAuth(
	modelRuntime: ModelRuntime,
	model: Model<any>,
	signal?: AbortSignal,
): Promise<RequestAuth> {
	let result: AuthResult | undefined;
	try {
		result = await modelRuntime.getAuth(model, { signal });
	} catch (error) {
		const cause = error instanceof Error ? error.cause : undefined;
		if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
			throw new Error(formatNoApiKeyFoundMessage(model.provider), { cause: error });
		}
		throw error;
	}
	if (result && (result.auth.apiKey || result.auth.headers)) {
		const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
		return {
			model: requestModel,
			apiKey: result.auth.apiKey,
			headers: withoutDeletedHeaders(result.auth.headers),
			env: result.env,
		};
	}

	const isOAuth = modelRuntime.isUsingOAuth(model.provider);
	if (isOAuth) {
		throw new Error(formatAuthExpiredMessage(model.provider));
	}
	throw new Error(formatNoApiKeyFoundMessage(model.provider));
}

export async function getSummarizationRequestAuth(
	session: Pick<SessionPublic, "modelRuntime" | "agent" | "messages" | "thinkingLevel">,
	selectedModel: Model<any>,
	signal?: AbortSignal,
): Promise<RequestAuth & { thinkingLevel: ThinkingLevel }> {
	const modelRuntime = session.modelRuntime;
	// Route a virtual model first: summaries size their input and output from the model they get.
	const { model, thinkingLevel } = isVirtualModel(selectedModel)
		? await modelRuntime.resolveModel(selectedModel, convertToLlm(session.messages), {
				reason: "direct",
				thinkingLevel: session.thinkingLevel,
				signal,
			})
		: { model: selectedModel, thinkingLevel: session.thinkingLevel };
	if (session.agent.streamFunction === streamSimple) {
		return {
			...(await getRequiredRequestAuth(modelRuntime, model, signal)),
			thinkingLevel,
		};
	}

	try {
		const result = await modelRuntime.getAuth(model, { signal });
		if (!result) return { model, thinkingLevel };
		const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
		return {
			model: requestModel,
			apiKey: result.auth.apiKey,
			headers: withoutDeletedHeaders(result.auth.headers),
			env: result.env,
			thinkingLevel,
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		return { model, thinkingLevel };
	}
}
