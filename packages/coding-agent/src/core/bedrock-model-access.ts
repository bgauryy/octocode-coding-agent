import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthResult } from "@octocodeai/octocode-ai";
import { isBedrockInferenceHost } from "@octocodeai/octocode-ai/utils/provider-host";
import { untilAborted } from "@octocodeai/octocode-common/abort";
import { deadline } from "@octocodeai/octocode-common/deadline";
import { isOfflineModeEnabled } from "../utils/env-flag.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const exec = promisify(execFile);
type Candidate = { provider: string; id: string; baseUrl?: string; api?: string };
type Kind = "foundation" | "profile";
const GEO = /^(?:global|us-gov|us|eu|apac|au|jp|in|ca)\./;
const PROFILE_ARN =
	/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):\d*:(?:application-)?inference-profile\/[a-zA-Z0-9.:-]+$/;
const DENIED = new Set([
	"account not authorized",
	"no entitlement",
	"unavailable in region",
	"agreement pending",
	"agreement unavailable",
	"profile not found in region",
	"model not found in region",
]);

export function isBedrockCandidate(model: Candidate): boolean {
	return model.provider === "amazon-bedrock" || (model.baseUrl !== undefined && isBedrockInferenceHost(model.baseUrl));
}

function accessStatus(raw: string, id: string, kind: Kind): string {
	const data = JSON.parse(raw);
	if (kind === "profile") {
		if (data?.inferenceProfileId !== id && data?.inferenceProfileArn !== id) return "unverified (unexpected profile)";
		return data.status === "ACTIVE" ? "profile active" : "unverified (profile status)";
	}
	if (data?.modelId !== id) return "unverified (unexpected model)";
	if (data.authorizationStatus === "NOT_AUTHORIZED") return "account not authorized";
	if (data.entitlementAvailability === "NOT_AVAILABLE") return "no entitlement";
	if (data.regionAvailability === "NOT_AVAILABLE") return "unavailable in region";
	const agreement = data.agreementAvailability?.status;
	if (agreement === "PENDING") return "agreement pending";
	if (agreement === "NOT_AVAILABLE") return "agreement unavailable";
	return data.authorizationStatus === "AUTHORIZED" &&
		data.entitlementAvailability === "AVAILABLE" &&
		data.regionAvailability === "AVAILABLE" &&
		agreement === "AVAILABLE"
		? "entitled"
		: "unverified";
}

/** AccessDenied on a metadata API concerns permission to *inspect* access. Only the named missing resource is definitive. */
async function lookup(
	kind: Kind,
	id: string,
	auth: AuthResult,
	region: string,
	passRegion: boolean,
	signal: AbortSignal,
	fetchAccess: typeof fetch,
): Promise<string> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...auth.env,
		AWS_PAGER: "",
		AWS_CLI_AUTO_PROMPT: "off",
		AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
	};
	const bearer =
		auth.auth.apiKey ?? (auth.source === "AWS_BEARER_TOKEN_BEDROCK" ? env.AWS_BEARER_TOKEN_BEDROCK : undefined);
	const missing = kind === "profile" ? "profile not found in region" : "model not found in region";
	if (!bearer && auth.source === "AWS_BEARER_TOKEN_BEDROCK") return "unverified (bearer credential unavailable)";
	if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)) return "unverified (invalid AWS region)";
	try {
		signal.throwIfAborted();
		if (bearer) {
			const endpoint = `https://bedrock.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
			const path = kind === "profile" ? "inference-profiles" : "foundation-model-availability";
			const response = await fetchAccess(`${endpoint}/${path}/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${bearer}` },
				redirect: "error",
				signal,
			});
			const raw = await response.text();
			if (response.ok) return accessStatus(raw, id, kind);
			const code = response.headers.get("x-amzn-errortype") ?? raw;
			return response.status === 404 && /\bResourceNotFoundException\b/.test(code)
				? missing
				: `unverified (AWS lookup HTTP ${response.status})`;
		}
		const [command, flag] =
			kind === "profile"
				? ["get-inference-profile", "--inference-profile-identifier"]
				: ["get-foundation-model-availability", "--model-id"];
		const { stdout } = await exec(
			"aws",
			[
				"bedrock",
				command,
				flag,
				id,
				"--output",
				"json",
				...(passRegion ? ["--region", region] : []),
				...(auth.env?.AWS_PROFILE ? ["--profile", auth.env.AWS_PROFILE] : []),
			],
			{ env, signal, timeout: 5000, maxBuffer: 32768 },
		);
		return accessStatus(stdout, id, kind);
	} catch (error) {
		const e = error as NodeJS.ErrnoException & { stderr?: string };
		if (e.stderr && /\(ResourceNotFoundException\)/.test(e.stderr)) return missing;
		return e.code === "ENOENT"
			? "unverified (install AWS CLI)"
			: "unverified (check AWS region, permission or timeout)";
	}
}

/** Mantle serves a separate catalog, including models that cannot be invoked on Bedrock Runtime. */
async function mantleAccess(
	endpoint: URL,
	id: string,
	auth: AuthResult,
	signal: AbortSignal,
	fetchAccess: typeof fetch,
): Promise<string> {
	const bearer =
		auth.auth.apiKey ??
		(auth.source === "AWS_BEARER_TOKEN_BEDROCK"
			? (auth.env?.AWS_BEARER_TOKEN_BEDROCK ?? process.env.AWS_BEARER_TOKEN_BEDROCK)
			: undefined);
	if (!bearer) return "unverified (requires Bedrock bearer key)";
	try {
		const response = await fetchAccess(`${endpoint.origin}/v1/models/${encodeURIComponent(id)}`, {
			headers: { Authorization: `Bearer ${bearer}` },
			redirect: "error",
			signal,
		});
		const body = await response.json();
		if (response.ok && body?.id === id && (body.status === "available" || body.status === undefined))
			return "listed on Mantle";
		if (
			response.status === 404 &&
			(body?.error?.code === "model_not_found" || body?.__type === "ResourceNotFoundException")
		)
			return "model not found in region";
		return response.ok ? "unverified (unexpected Mantle model)" : `unverified (AWS lookup HTTP ${response.status})`;
	} catch {
		return "unverified (check Mantle permissions, response or timeout)";
	}
}

/** Inference-free control-plane lookups. A regional profile and its foundation model are distinct resources. */
export async function bedrockModelAccess<T extends Candidate>(
	runtime: Pick<ModelRuntime, "getAuth">,
	models: readonly T[],
	signal?: AbortSignal,
	fetchAccess: typeof fetch = fetch,
): Promise<Map<T, string>> {
	const results = new Map<T, string>();
	const targets = models.filter(isBedrockCandidate);
	if (!targets.length) return results;
	const auths = new Map<string, Promise<AuthResult | undefined>>();
	const queries = new Map<string, Promise<string>>();
	const limit = deadline(10000, signal);
	async function check(model: T): Promise<string> {
		let pendingAuth = auths.get(model.provider);
		if (!pendingAuth) {
			pendingAuth = runtime.getAuth(model.provider, { signal: limit.signal });
			auths.set(model.provider, pendingAuth);
		}
		const auth = await pendingAuth;
		if (!auth) return "unverified (requires AWS account credentials)";
		const endpoint = auth.auth.baseUrl ?? model.baseUrl;
		if (endpoint && !isBedrockInferenceHost(endpoint)) return "unverified (custom endpoint)";
		if (model.provider !== "amazon-bedrock" && !auth.auth.apiKey) return "unverified (custom authentication)";
		const url = endpoint ? new URL(endpoint) : undefined;
		if (url && (url.protocol !== "https:" || url.port)) return "unverified (custom endpoint)";
		if (url?.hostname.startsWith("bedrock-mantle")) return mantleAccess(url, model.id, auth, limit.signal, fetchAccess);
		const endpointRegion = url?.hostname.split(".")[1];
		const arn = PROFILE_ARN.exec(model.id);
		const configured =
			auth.env?.AWS_REGION ?? auth.env?.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
		const explicitEndpoint = Boolean(
			auth.auth.baseUrl || model.provider !== "amazon-bedrock" || model.api?.startsWith("openai-"),
		);
		const region =
			arn?.[1] || (explicitEndpoint ? endpointRegion || configured : configured || endpointRegion) || "us-east-1";
		const credentialsProfile = auth.env?.AWS_PROFILE ?? process.env.AWS_PROFILE;
		const passRegion =
			arn !== null || explicitEndpoint || Boolean(configured) || (!credentialsProfile && Boolean(endpointRegion));
		const query = (kind: Kind, id: string) => {
			const key = JSON.stringify([model.provider, region, kind, id]);
			let result = queries.get(key);
			if (!result) {
				result = lookup(kind, id, auth, region, passRegion, limit.signal, fetchAccess);
				queries.set(key, result);
			}
			return result;
		};
		if (arn || /^[a-z0-9]{12}$/.test(model.id)) return query("profile", model.id);
		const base = model.id.replace(GEO, "");
		if (!/^[a-z0-9-]+\.[a-z0-9.:-]+$/.test(base)) return "unverified (custom model)";
		if (base === model.id) return query("foundation", base);
		const [profile, foundation] = await Promise.all([query("profile", model.id), query("foundation", base)]);
		if (profile === "profile not found in region") return profile;
		// A cross-region profile can route to a destination where the base model is offered.
		if (foundation === "unavailable in region" || foundation === "model not found in region")
			return profile === "profile active" ? "unverified (profile active; destination entitlement unknown)" : profile;
		if (DENIED.has(foundation)) return foundation;
		return profile === "profile active" ? foundation : profile;
	}
	const pending = targets.values();
	async function worker() {
		for (const model of pending) {
			if (limit.signal.aborted) break;
			const result = await check(model);
			if (!limit.signal.aborted) results.set(model, result);
		}
	}
	try {
		await untilAborted(Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker)), limit.signal);
	} catch (error) {
		signal?.throwIfAborted();
		if (!limit.signal.aborted) throw error;
		for (const model of targets) if (!results.has(model)) results.set(model, "unverified (AWS lookup timed out)");
	} finally {
		limit.clear();
	}
	return results;
}

/** A selection only stops on affirmative rejection. A control-plane lookup can require permissions that inference does not. */
export async function preflightBedrockSelection(
	runtime: Pick<ModelRuntime, "getAuth" | "setModelAccess" | "isModelAccessRejected" | "modelAccessGeneration">,
	model: Candidate,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!isBedrockCandidate(model)) return;
	const generation = runtime.modelAccessGeneration;
	const limit = deadline(2500, signal);
	let result: string | undefined;
	try {
		result = isOfflineModeEnabled()
			? "unverified (offline mode)"
			: (await bedrockModelAccess(runtime, [model], limit.signal)).get(model);
	} catch (error) {
		signal?.throwIfAborted();
		if (!limit.signal.aborted) throw error;
		result = "unverified (AWS lookup timed out)";
	} finally {
		limit.clear();
	}
	if (runtime.modelAccessGeneration !== generation)
		result = "unverified (provider configuration changed during lookup)";
	if (result && DENIED.has(result)) runtime.setModelAccess(model, true, generation);
	if ((result && DENIED.has(result)) || runtime.isModelAccessRejected(model))
		throw new Error(
			`${model.provider}/${model.id} is unavailable for this AWS account or region (${result && DENIED.has(result) ? result : "previous request rejected"}). Choose another model or recheck access in /providers.`,
		);
	return result?.startsWith("unverified")
		? `AWS model access ${result}. The first request will confirm access.`
		: undefined;
}

/** An explicit recheck lets the user retry a previously rejected model once AWS reports a positive result. */
export function applyBedrockAccessCheck(
	runtime: Pick<ModelRuntime, "setModelAccess">,
	model: Candidate,
	result: string | undefined,
	generation: number,
): void {
	if (
		result &&
		(DENIED.has(result) || result === "entitled" || result === "profile active" || result === "listed on Mantle")
	)
		runtime.setModelAccess(model, DENIED.has(result), generation);
}
