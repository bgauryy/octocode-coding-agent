import { GITHUB_COPILOT_MODELS } from "../../../providers/github-copilot.models.ts";
import { MAX_AUTH_ERROR_BODY_CHARS, summarizeErrorBody } from "../../../utils/error-body.ts";
import { sleep } from "../../../utils/sleep.ts";
import { COPILOT_API_VERSION, COPILOT_HEADERS, getGitHubCopilotBaseUrl } from "./endpoints.ts";

/** The response body for an error message: credentials removed and cut short. */
async function errorBodyText(response: Response): Promise<string> {
	return summarizeErrorBody(await response.text().catch(() => ""), MAX_AUTH_ERROR_BODY_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseGitHubCopilotModelCatalog(raw: unknown, allowPolicyFallback: boolean) {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	const accountModels = data.flatMap((rawItem) => {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (!item || typeof id !== "string") return [];

		const capabilities = asRecord(item.capabilities);
		const supports = asRecord(capabilities?.supports);
		if (supports?.tool_calls === false) return [];

		return [
			{
				id,
				pickerEnabled: item.model_picker_enabled === true,
				policyState: asRecord(item.policy)?.state,
			},
		];
	});
	const pickerModelIds = accountModels
		.filter((model) => model.pickerEnabled && model.policyState !== "disabled")
		.map((model) => model.id);
	const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
	const availableModelIds =
		pickerModelIds.length > 0 || !allowPolicyFallback
			? pickerModelIds
			: accountModels.filter((model) => model.policyState === "enabled").map((model) => model.id);
	const policyModelIds = accountModels
		.filter(
			(model) =>
				model.policyState === "unconfigured" &&
				Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
				(model.pickerEnabled || usePolicyFallback),
		)
		.map((model) => model.id);
	return { availableModelIds, policyModelIds };
}

async function fetchWithRateLimitRetry(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
): Promise<Response> {
	const retryBudgetSignal =
		retryPolicy.maxRetries > 0 && retryPolicy.maxElapsedMs > 0
			? AbortSignal.timeout(retryPolicy.maxElapsedMs)
			: undefined;
	const requestSignal = retryBudgetSignal ? AbortSignal.any([signal, retryBudgetSignal]) : signal;
	const retryDeadline = retryBudgetSignal ? Date.now() + retryPolicy.maxElapsedMs : undefined;
	for (let retry = 0; ; retry++) {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]),
		});
		if (response.status !== 429 || retry === retryPolicy.maxRetries) return response;

		const retryAfter = response.headers.get("retry-after");
		let delayMs = 500 * 2 ** retry;
		if (retryAfter) {
			const seconds = Number.parseFloat(retryAfter);
			delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
			if (!Number.isFinite(delayMs)) return response;
		}
		delayMs = Math.max(0, delayMs);
		if (retryDeadline !== undefined && delayMs >= retryDeadline - Date.now()) return response;
		await response.body?.cancel();
		await sleep(delayMs, requestSignal);
	}
}

export async function fetchGitHubCopilotModels(
	copilotToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
) {
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
	// Some Individual accounts return false for every picker flag despite explicit enabled policies.
	// Limit the fallback to that endpoint so other account types keep strict picker semantics.
	const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
	const response = await fetchWithRateLimitRetry(
		`${baseUrl}/models`,
		{
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${copilotToken}`,
				...COPILOT_HEADERS,
				"X-GitHub-Api-Version": COPILOT_API_VERSION,
			},
		},
		signal,
		retryPolicy,
	);
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}: ${await errorBodyText(response)}`);
	}
	return parseGitHubCopilotModelCatalog(await response.json(), allowPolicyFallback);
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	let response: Response;
	try {
		response = await fetchWithRateLimitRetry(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					...COPILOT_HEADERS,
					"openai-intent": "chat-policy",
					"x-interaction-type": "chat-policy",
				},
				body: JSON.stringify({ state: "enabled" }),
			},
			signal,
			{ maxRetries: 2, maxElapsedMs: 5000 },
		);
	} catch (error) {
		if (signal.aborted) throw error;
		return false;
	}
	if (response.status === 429) {
		throw new Error(`${response.status} ${response.statusText}: ${await errorBodyText(response)}`);
	}
	return response.ok;
}

/**
 * Enable the requested GitHub Copilot models and return the successful IDs.
 * Policy updates are best effort; exhausted rate limiting stops the batch.
 */
export async function enableGitHubCopilotModels(
	token: string,
	modelIds: readonly string[],
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	const enabledModelIds: string[] = [];
	for (const modelId of modelIds) {
		try {
			if (await enableGitHubCopilotModel(token, modelId, enterpriseDomain, signal)) {
				enabledModelIds.push(modelId);
			}
		} catch (error) {
			if (signal.aborted) throw error;
			break;
		}
	}
	return enabledModelIds;
}
