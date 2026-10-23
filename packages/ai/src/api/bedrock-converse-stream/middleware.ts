import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { BuildMiddleware, DeserializeMiddleware, HttpResponse, MetadataBearer } from "@smithy/types";
import type { Model, ProviderResponse } from "../../types.ts";
import type { BedrockOptions } from "./types.ts";

/**
 * Header keys that must never be overwritten by caller-supplied headers.
 * `host` and `x-amz-*` participate in the SigV4 canonical request; `authorization`
 * is owned by SigV4 or the bearer-token path (config.token + authSchemePreference).
 * Compared case-insensitively (caller key is lower-cased before lookup).
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * Attach caller-supplied headers to the outgoing Bedrock request via a Smithy
 * `build`-step middleware. The `build` step runs after request serialisation but
 * before SigV4 signing, so injected headers are covered by the signature. Reserved
 * SigV4 / auth headers (`x-amz-*`, `authorization`, `host`) are silently skipped;
 * all other caller headers override any existing same-named header on the request.
 */
export function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "octocode-ai-custom-headers", priority: "low" });
}

function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	if (!response || typeof response !== "object") return false;
	const candidate = response as Partial<HttpResponse>;
	return typeof candidate.statusCode === "number" && !!candidate.headers && typeof candidate.headers === "object";
}

function toProviderResponse(response: unknown): ProviderResponse | undefined {
	if (!isSmithyHttpResponse(response)) return undefined;
	return { status: response.statusCode, headers: { ...response.headers } };
}

/**
 * Bedrock's modeled `$metadata` only preserves selected HTTP metadata (for example
 * requestId), so custom gateway headers are otherwise lost before callers see
 * `onResponse`. Capture the raw Smithy HTTP response at the deserialize step,
 * after the SDK receives the response but before the event stream is consumed.
 */
export function addResponseHeadersMiddleware(
	client: BedrockRuntimeClient,
	onResponse: NonNullable<BedrockOptions["onResponse"]>,
	model: Model<"bedrock-converse-stream">,
	onObserved: () => void,
): void {
	const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const result = await next(args);
		const providerResponse = toProviderResponse(result.response);
		if (providerResponse) {
			onObserved();
			await onResponse(providerResponse, model);
		}
		return result;
	};
	client.middlewareStack.add(middleware, { step: "deserialize", name: "octocode-ai-response-headers" });
}
