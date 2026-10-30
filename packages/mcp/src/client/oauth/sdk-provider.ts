import {
	AuthorizationServerMismatchError,
	type OAuthClientProvider as SdkOAuthClientProvider,
	validateClientMetadataUrl,
} from "@modelcontextprotocol/client";
import { discoverOAuthServerInfo } from "./discovery.ts";
import type { OAuthClientMetadataDocument, OAuthClientProvider, OAuthFlowOptions } from "./flow.ts";
import type { OAuthDiscoveryState } from "./types.ts";

/** Adapt host configuration, cancellation and grant persistence to the SDK provider contract. */
export async function createSdkOAuthProvider(
	provider: OAuthClientProvider,
	options: OAuthFlowOptions,
): Promise<SdkOAuthClientProvider> {
	let discovery = await provider.discoveryState?.();
	if (options.authorizationServerMetadataUrl) {
		const configured = await discoverOAuthServerInfo(options.serverUrl, options);
		const recordedIssuer = discovery?.authorizationServerMetadata?.issuer ?? discovery?.authorizationServerUrl;
		const issuer = configured.authorizationServerMetadata?.issuer ?? configured.authorizationServerUrl;
		if (options.authorizationCode && recordedIssuer && recordedIssuer !== issuer) {
			throw new AuthorizationServerMismatchError(recordedIssuer, issuer);
		}
		discovery = configured;
	}
	let document: OAuthClientMetadataDocument | undefined;
	let grantedScope: string | undefined;
	const check = () => options.signal?.throwIfAborted();
	const saveDiscovery = async (state: OAuthDiscoveryState) => {
		check();
		discovery = state;
		// A configured metadata URL is reloaded each flow so a changed override takes effect immediately.
		if (!options.authorizationServerMetadataUrl) await provider.saveDiscoveryState?.(state);
	};
	return {
		get redirectUrl() {
			return document?.redirectUrl ?? provider.redirectUrl;
		},
		clientMetadata: provider.clientMetadata,
		state:
			provider.state &&
			(() => {
				check();
				return provider.state!();
			}),
		clientInformation: async () => {
			check();
			const stored = await provider.clientInformation();
			if (stored) return stored;
			document = provider.clientMetadataDocument?.(discovery?.authorizationServerMetadata);
			if (!document) return undefined;
			if (!document.url) throw new Error("Invalid OAuth client metadata URL");
			validateClientMetadataUrl(document.url);
			// Host-selected documents are never persisted as a dynamic registration.
			return { client_id: document.url };
		},
		saveClientInformation:
			provider.saveClientInformation &&
			(async (information) => {
				check();
				if (!document) await provider.saveClientInformation!(information);
			}),
		tokens: async () => {
			check();
			const tokens = await provider.tokens();
			grantedScope = tokens?.scope;
			return tokens;
		},
		saveTokens: async (tokens) => {
			check();
			// RFC 6749: omitted scope keeps the old grant on refresh and the requested grant on exchange.
			let scope = grantedScope;
			if (options.authorizationCode) {
				scope =
					options.scope || discovery?.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
				if (
					scope &&
					discovery?.authorizationServerMetadata?.scopes_supported?.includes("offline_access") &&
					provider.clientMetadata.grant_types?.includes("refresh_token") &&
					!scope.split(" ").includes("offline_access")
				) {
					scope += " offline_access";
				}
			}
			await provider.saveTokens(tokens.scope === undefined && scope ? { ...tokens, scope } : tokens);
		},
		redirectToAuthorization: async (url) => {
			check();
			await provider.redirectToAuthorization(url);
		},
		saveCodeVerifier: async (verifier) => {
			check();
			await provider.saveCodeVerifier(verifier);
		},
		codeVerifier: () => {
			check();
			return provider.codeVerifier();
		},
		addClientAuthentication: provider.addClientAuthentication?.bind(provider),
		invalidateCredentials:
			provider.invalidateCredentials &&
			(async (kind) => {
				check();
				if (kind === "all" || kind === "discovery") discovery = undefined;
				await provider.invalidateCredentials!(kind);
			}),
		discoveryState: () => {
			check();
			return discovery;
		},
		saveDiscoveryState: saveDiscovery,
	};
}
