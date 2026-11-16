import type { AssistantMessage, JsonObject } from "../../types.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { normalizeProviderError } from "../../utils/error-body.ts";

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Some models reject the account/profile's configured Bedrock data retention mode
 * (e.g. "data retention mode 'default' is not available for this model"). Point
 * users at the AWS docs explaining how to configure a supported mode.
 */
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
export function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	// Surface the raw HTTP body (with status) when the SDK did not fold it into
	// the message; otherwise fall back to the message. This is what stops a
	// gateway 403 from collapsing to `Unknown: UnknownError`.
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	const dataRetentionHint = /data retention mode/i.test(core)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof Error && error.name.endsWith("Exception")) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	return `${core}${dataRetentionHint}`;
}

type SdkErrorMetadata = {
	$metadata?: { httpStatusCode?: unknown; requestId?: unknown };
	statusCode?: number;
	responseHeaders?: Record<string, string>;
	type?: string;
};

/** Over-long header values are dropped rather than truncated: a truncated request id is not a request id. */
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;

function normalizeDiagnosticValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS) return undefined;
	return trimmed;
}

/**
 * The SDK puts the modeled code on `error.name` for service exceptions and unmodeled stream errors alike, so
 * do not narrow to `BedrockRuntimeServiceException`. Modeled Bedrock errors all end in `Exception`, unlike
 * transport names such as `TimeoutError`.
 */
function extractBedrockErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	return normalizeDiagnosticValue(error.name);
}

/**
 * Structured metadata alongside `errorMessage`, which stays byte-identical because `isRetryableAssistantError`
 * matches against it. Unknown fields are omitted, never guessed: a modeled mid-stream exception reaches us as
 * a bare object literal, leaving only `fallbackRequestId`. `details` only, as the throw is not always `Error`.
 */
export function appendBedrockFailureDiagnostic(
	output: AssistantMessage,
	error: unknown,
	fallbackRequestId: string | undefined,
): void {
	const sdkError = error as SdkErrorMetadata;
	const metadata = sdkError?.$metadata ?? {
		httpStatusCode: sdkError?.type ? undefined : sdkError?.statusCode,
		requestId: sdkError?.responseHeaders?.["x-amzn-requestid"],
	};
	const details: JsonObject = {};

	if (typeof metadata?.httpStatusCode === "number") details.status = metadata.httpStatusCode;

	let errorCode = extractBedrockErrorCode(error);
	const headerCode = sdkError?.responseHeaders?.["x-amzn-errortype"]?.split(":")[0];
	if (!errorCode && headerCode?.endsWith("Exception")) errorCode = normalizeDiagnosticValue(headerCode);
	if (!errorCode && sdkError?.type?.endsWith("Exception")) {
		errorCode = normalizeDiagnosticValue(sdkError.type[0].toUpperCase() + sdkError.type.slice(1));
	}
	if (errorCode !== undefined) details.errorCode = errorCode;

	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? normalizeDiagnosticValue(fallbackRequestId);
	if (requestId !== undefined) details.requestId = requestId;

	if (Object.keys(details).length === 0) return;

	appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}
