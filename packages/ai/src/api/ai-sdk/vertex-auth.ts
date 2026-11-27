import { readFileSync } from "node:fs";
import { type AuthClient, ExternalAccountClient, Impersonated, JWT, UserRefreshClient } from "google-auth-library";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export interface VertexAuth {
	/** Undefined: Application Default Credentials discovery applies. */
	authClient?: AuthClient;
	/** Billing project for user credentials, sent as x-goog-user-project. */
	quotaProjectId?: string;
}

type Json = Record<string, unknown>;

/**
 * Builds the Vertex auth client from a credentials file (GOOGLE_APPLICATION_CREDENTIALS), checking its type first.
 * Google deprecates handing a key file path to the auth library unvalidated, so each supported type is built
 * with its own client: service_account, authorized_user, external_account (workload identity federation) and
 * impersonated_service_account. GOOGLE_CLOUD_QUOTA_PROJECT overrides the file's quota_project_id.
 */
export function vertexAuth(path: string | undefined, quotaProjectEnv: string | undefined): VertexAuth {
	if (!path) return { quotaProjectId: quotaProjectEnv };
	let credentials: Json;
	try {
		credentials = JSON.parse(readFileSync(path, "utf8")) as Json;
	} catch {
		throw new Error(
			`Vertex AI credentials file at GOOGLE_APPLICATION_CREDENTIALS (${path}) is missing or not valid JSON.`,
		);
	}
	const quotaProjectId = quotaProjectEnv ?? text(credentials, "quota_project_id");
	const authClient = clientFor(credentials, true);
	if (quotaProjectId) authClient.quotaProjectId = quotaProjectId;
	return { authClient, quotaProjectId };
}

function text(json: Json, key: string): string | undefined {
	const value = json[key];
	return typeof value === "string" ? value : undefined;
}

function clientFor(credentials: Json, allowImpersonation: boolean): AuthClient {
	switch (credentials.type) {
		case "service_account": {
			const email = text(credentials, "client_email");
			const key = text(credentials, "private_key");
			if (!email || !key) throw new Error("Vertex AI service account credentials need client_email and private_key.");
			return new JWT({
				email,
				key,
				keyId: text(credentials, "private_key_id"),
				scopes: [CLOUD_PLATFORM_SCOPE],
				universeDomain: text(credentials, "universe_domain"),
			});
		}
		case "authorized_user": {
			const clientId = text(credentials, "client_id");
			const clientSecret = text(credentials, "client_secret");
			const refreshToken = text(credentials, "refresh_token");
			if (!clientId || !clientSecret || !refreshToken)
				throw new Error("Vertex AI user credentials need client_id, client_secret and refresh_token.");
			return new UserRefreshClient({
				clientId,
				clientSecret,
				refreshToken,
				universeDomain: text(credentials, "universe_domain"),
			});
		}
		case "external_account": {
			// The user named this file, as gcloud ADC would load it; fromJSON validates the shape.
			const audience = text(credentials, "audience");
			const subjectTokenType = text(credentials, "subject_token_type");
			if (!audience || !subjectTokenType)
				throw new Error("Vertex AI external_account credentials need audience and subject_token_type.");
			const client = ExternalAccountClient.fromJSON({
				...credentials,
				type: "external_account",
				audience,
				subject_token_type: subjectTokenType,
				scopes: [CLOUD_PLATFORM_SCOPE],
			});
			if (!client) throw new Error("Vertex AI external_account credentials are not a recognized configuration.");
			return client;
		}
		case "impersonated_service_account": {
			const source = credentials.source_credentials;
			const url = text(credentials, "service_account_impersonation_url");
			const targetPrincipal = url && url.length <= 256 ? /([^/]+):generateAccessToken$/.exec(url)?.[1] : undefined;
			if (!allowImpersonation || !source || typeof source !== "object" || !targetPrincipal)
				throw new Error(
					"Vertex AI impersonated credentials need source_credentials and a service_account_impersonation_url ending in :generateAccessToken.",
				);
			const delegates = Array.isArray(credentials.delegates)
				? credentials.delegates.filter((d): d is string => typeof d === "string")
				: [];
			return new Impersonated({
				sourceClient: clientFor(source as Json, false),
				targetPrincipal,
				delegates,
				targetScopes: [CLOUD_PLATFORM_SCOPE],
			});
		}
		default:
			throw new Error(
				`Vertex AI credentials type ${JSON.stringify(credentials.type ?? null)} is not supported; use a service_account, authorized_user, external_account or impersonated_service_account file, or unset GOOGLE_APPLICATION_CREDENTIALS to use gcloud credentials.`,
			);
	}
}
