/**
 * GitHub Copilot through an Octocode GitHub OAuth app, the way OpenCode signs in with its own app: the GitHub token is
 * used directly against the Copilot API with Octocode's identity, and `/copilot_internal/user` says whether the
 * account has Copilot and which API endpoint serves it.
 */

import type { OAuthCredential, ProviderAuthInteraction } from "../../types.ts";
import {
	copilotUserHeaders,
	copilotUserUrl,
	fetchJson,
	normalizeDomain,
	octocodeCopilotBaseUrl,
	octocodeCopilotHeaders,
} from "./endpoints.ts";
import { type CopilotRoute, enableGitHubCopilotModels, fetchGitHubCopilotModels } from "./models.ts";

/** Marks a credential signed in through an Octocode GitHub OAuth app. */
const OCTOCODE_IDENTITY = "octocode";
/** A GitHub OAuth token does not expire; the entitlement and model list are checked again this often. */
const RECHECK_MS = 24 * 60 * 60 * 1000;

interface CopilotUser {
	chat_enabled?: boolean;
	can_signup_for_limited?: boolean;
	endpoints?: { api?: string };
}

export function isOctocodeCopilotCredential(credential: OAuthCredential): boolean {
	return credential.identity === OCTOCODE_IDENTITY;
}

/**
 * Why the account cannot use Copilot, from GitHub's entitlement answer. OAuth succeeds for any GitHub account, so this
 * is the only signal that it can chat.
 */
function copilotEntitlementError(user: CopilotUser): string | undefined {
	if (user.chat_enabled !== false) return undefined;
	if (user.can_signup_for_limited) {
		return "This GitHub account is not signed up for GitHub Copilot. Sign up for Copilot Free at https://github.com/features/copilot/plans and sign in again.";
	}
	return "This GitHub account does not have GitHub Copilot access. It needs an active Copilot subscription or a seat assigned by an organization.";
}

function asCopilotUser(raw: unknown): CopilotUser | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const endpoints = record.endpoints && typeof record.endpoints === "object" ? record.endpoints : undefined;
	const api = endpoints ? (endpoints as Record<string, unknown>).api : undefined;
	return {
		...(typeof record.chat_enabled === "boolean" ? { chat_enabled: record.chat_enabled } : {}),
		...(typeof record.can_signup_for_limited === "boolean"
			? { can_signup_for_limited: record.can_signup_for_limited }
			: {}),
		...(typeof api === "string" ? { endpoints: { api } } : {}),
	};
}

/** The entitlement answer; a failed or malformed lookup is unknown, so a GitHub hiccup never becomes a denial. */
async function fetchCopilotUser(
	githubToken: string,
	domain: string,
	signal: AbortSignal,
): Promise<CopilotUser | undefined> {
	try {
		return asCopilotUser(await fetchJson(copilotUserUrl(domain), { headers: copilotUserHeaders(githubToken), signal }));
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

function httpsEndpoint(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href.replace(/\/+$/, "") : undefined;
	} catch {
		return undefined;
	}
}

function enterpriseDomainOf(credential: OAuthCredential): string | undefined {
	const enterpriseUrl = credential.enterpriseUrl;
	return typeof enterpriseUrl === "string" && enterpriseUrl ? (normalizeDomain(enterpriseUrl) ?? undefined) : undefined;
}

/** The Copilot API an Octocode credential's requests go to: the account's endpoint, else the public one. */
export function octocodeCopilotRequestBaseUrl(credential: OAuthCredential): string {
	return httpsEndpoint(credential.apiEndpoint) ?? octocodeCopilotBaseUrl(enterpriseDomainOf(credential));
}

async function checkAccount(
	githubToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
	previousEndpoint?: unknown,
): Promise<{ apiEndpoint?: string; route: CopilotRoute }> {
	const user = await fetchCopilotUser(githubToken, enterpriseDomain || "github.com", signal);
	const denied = user && copilotEntitlementError(user);
	if (denied) throw new Error(denied);
	const apiEndpoint = httpsEndpoint(user?.endpoints?.api) ?? httpsEndpoint(previousEndpoint);
	const baseUrl = apiEndpoint ?? octocodeCopilotBaseUrl(enterpriseDomain);
	return { ...(apiEndpoint ? { apiEndpoint } : {}), route: { baseUrl, headers: octocodeCopilotHeaders() } };
}

function credentialFor(
	githubToken: string,
	enterpriseDomain: string | undefined,
	clientId: unknown,
	apiEndpoint: string | undefined,
	availableModelIds: unknown,
): OAuthCredential {
	return {
		type: "oauth",
		refresh: githubToken,
		access: githubToken,
		expires: Date.now() + RECHECK_MS,
		identity: OCTOCODE_IDENTITY,
		...(typeof clientId === "string" ? { clientId } : {}),
		...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
		...(apiEndpoint ? { apiEndpoint } : {}),
		...(availableModelIds !== undefined ? { availableModelIds } : {}),
	};
}

/** Finish a sign-in through the Octocode app: check the entitlement, read the models and enable the ones that need it. */
export async function completeOctocodeCopilotLogin(
	interaction: ProviderAuthInteraction,
	githubToken: string,
	enterpriseDomain: string | undefined,
	clientId: string,
): Promise<OAuthCredential> {
	const { apiEndpoint, route } = await checkAccount(githubToken, enterpriseDomain, interaction.signal);
	const models = await fetchGitHubCopilotModels(
		githubToken,
		enterpriseDomain,
		interaction.signal,
		{ maxRetries: 2, maxElapsedMs: 5000 },
		route,
	);
	let enabledModelIds: string[] = [];
	if (models.policyModelIds.length > 0) {
		interaction.notify({ type: "progress", message: "Enabling models..." });
		enabledModelIds = await enableGitHubCopilotModels(
			githubToken,
			models.policyModelIds,
			enterpriseDomain,
			interaction.signal,
			route,
		);
	}
	const availableModelIds = [...new Set([...models.availableModelIds, ...enabledModelIds])];
	return credentialFor(githubToken, enterpriseDomain, clientId, apiEndpoint, availableModelIds);
}

/**
 * The daily re-check of an Octocode credential. The token stays; the entitlement, endpoint and model list are read
 * again. A model list that cannot be read keeps the previous one.
 */
export async function refreshOctocodeCopilotCredential(
	credential: OAuthCredential,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const enterpriseDomain = enterpriseDomainOf(credential);
	const { apiEndpoint, route } = await checkAccount(
		credential.refresh,
		enterpriseDomain,
		signal,
		credential.apiEndpoint,
	);
	let availableModelIds: unknown = credential.availableModelIds;
	try {
		availableModelIds = (
			await fetchGitHubCopilotModels(
				credential.refresh,
				enterpriseDomain,
				signal,
				{ maxRetries: 0, maxElapsedMs: 0 },
				route,
			)
		).availableModelIds;
	} catch (error) {
		if (signal.aborted) throw error;
	}
	return credentialFor(credential.refresh, enterpriseDomain, credential.clientId, apiEndpoint, availableModelIds);
}
