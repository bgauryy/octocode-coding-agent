import { isOctocodeAppToken, VSCODE_IDENTITY_HEADERS } from "../auth/oauth/github-copilot/endpoints.ts";
import type { Api, Model, ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";
import { getUserAgent } from "../utils/user-agent.ts";

const DROPPED = new Set([...VSCODE_IDENTITY_HEADERS, "User-Agent"].map((name) => name.toLowerCase()));

function withoutVSCodeIdentity(headers: ProviderHeaders | undefined): ProviderHeaders | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED.has(name.toLowerCase())));
}

/**
 * The built-in Copilot models carry the VS Code client's headers, and a model's headers win over its auth headers.
 * A request signed in through an Octocode GitHub app sends Octocode's identity instead: the editor and integration
 * headers are dropped and the User-Agent names Octocode. Other requests pass unchanged.
 */
function asOctocode<TModel extends Model<Api>, TOptions extends StreamOptions>(
	model: TModel,
	options: TOptions | undefined,
): [TModel, TOptions | undefined] {
	// The credential decides, not a header: a models.json `X-GitHub-Api-Version` must not switch the identity.
	if (!options || !isOctocodeAppToken(options.apiKey)) return [model, options];
	return [
		{ ...model, headers: withoutVSCodeIdentity(model.headers) },
		{ ...options, headers: { ...withoutVSCodeIdentity(options.headers), "User-Agent": getUserAgent() } },
	];
}

/** Sends Octocode's identity on requests whose credential came from an Octocode GitHub app. */
export function withCopilotIdentity(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => {
			const [requestModel, requestOptions] = asOctocode(model, options);
			return streams.stream(requestModel, context, requestOptions);
		},
		streamSimple: (model, context, options) => {
			const [requestModel, requestOptions] = asOctocode(model, options);
			return streams.streamSimple(requestModel, context, requestOptions);
		},
	};
}
