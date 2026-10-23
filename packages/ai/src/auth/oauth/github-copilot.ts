/**
 * GitHub Copilot OAuth flow
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import {
	CLIENT_ID,
	COPILOT_HEADERS,
	fetchJson,
	getGitHubCopilotBaseUrl,
	getUrls,
	normalizeDomain,
} from "./github-copilot/endpoints.ts";
import { enableGitHubCopilotModels, fetchGitHubCopilotModels } from "./github-copilot/models.ts";

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval?: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
		signal,
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		(interval !== undefined && typeof interval !== "number") ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	// The verification URI is opened in the user's browser and to prevent `open` from
	// opening an executable or similar, we force it to be a URL.
	let parsedUri: URL;
	try {
		parsedUri = new URL(verificationUri);
	} catch {
		throw new Error("Untrusted verification_uri in device code response");
	}
	if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in device code response");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: parsedUri.href,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	device: DeviceCodeResponse,
	signal: AbortSignal,
): Promise<string> {
	const urls = getUrls(domain);
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const raw = await fetchJson(urls.accessTokenUrl, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "GitHubCopilotChat/0.35.0",
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: device.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			});

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
				return { status: "complete", value: (raw as DeviceTokenSuccessResponse).access_token };
			}

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
				const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
				if (error === "authorization_pending") {
					return { status: "pending" };
				}

				if (error === "slow_down") {
					return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
				}

				const descriptionSuffix = description ? `: ${description}` : "";
				return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
			}

			return { status: "failed", message: "Invalid device token response" };
		},
	});
}

async function refreshGitHubCopilotAccessToken(
	refreshToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
		signal,
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	return {
		type: "oauth",
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * Refresh GitHub Copilot token
 */
async function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain, signal);
	const { availableModelIds } = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain, signal, {
		maxRetries: 0,
		maxElapsedMs: 0,
	});
	return {
		...credentials,
		availableModelIds,
	};
}

async function loginGitHubCopilot(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const input = await interaction.prompt({
		type: "text",
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
	});
	if (interaction.signal.aborted) throw new Error("Login cancelled");

	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
	const domain = enterpriseDomain || "github.com";

	const device = await startDeviceFlow(domain, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
	const credentials = await refreshGitHubCopilotAccessToken(
		githubAccessToken,
		enterpriseDomain ?? undefined,
		interaction.signal,
	);
	const models = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined, interaction.signal, {
		maxRetries: 2,
		maxElapsedMs: 5000,
	});
	let enabledModelIds: string[] = [];
	if (models.policyModelIds.length > 0) {
		interaction.notify({ type: "progress", message: "Enabling models..." });
		enabledModelIds = await enableGitHubCopilotModels(
			credentials.access,
			models.policyModelIds,
			enterpriseDomain ?? undefined,
			interaction.signal,
		);
	}
	return {
		...credentials,
		availableModelIds: [...new Set([...models.availableModelIds, ...enabledModelIds])],
	};
}

function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
	const enterpriseUrl = credential.enterpriseUrl;
	if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
	return normalizeDomain(enterpriseUrl) ?? undefined;
}

export const githubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",
	isSubscription: true,
	login: loginGitHubCopilot,
	refresh: (credential, signal) =>
		refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential), signal),

	/** Derive the credential-specific proxy endpoint for each request. */
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
		};
	},
};
