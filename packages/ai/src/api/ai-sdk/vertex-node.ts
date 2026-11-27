import { createGoogleVertex, type GoogleVertexProviderSettings } from "@ai-sdk/google-vertex";
import type { LanguageModel } from "ai";
import { vertexAuth } from "./vertex-auth.ts";

type VertexCredentialSettings = Omit<GoogleVertexProviderSettings, "apiKey" | "googleAuthOptions" | "headers">;

export interface VertexNodeModule {
	/** Vertex with Google credentials (a credentials file or Application Default Credentials): Node only. */
	vertexCredentialsModel(
		settings: VertexCredentialSettings,
		modelId: string,
		credentialsPath: string | undefined,
		quotaProjectEnv: string | undefined,
	): LanguageModel;
}

export const vertexNodeModule: VertexNodeModule = {
	vertexCredentialsModel(settings, modelId, credentialsPath, quotaProjectEnv) {
		const auth = vertexAuth(credentialsPath, quotaProjectEnv);
		return createGoogleVertex({
			...settings,
			apiKey: "",
			googleAuthOptions: { authClient: auth.authClient },
			// The SDK reads only the access token, so the billing project header is set here.
			headers: auth.quotaProjectId ? { "x-goog-user-project": auth.quotaProjectId } : undefined,
		})(modelId);
	},
};
