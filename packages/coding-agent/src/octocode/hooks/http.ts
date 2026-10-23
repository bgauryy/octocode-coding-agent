import {
	type HookConfig,
	type HookHttp,
	type HookSource,
	HOOK_MAX_TIMEOUT_S,
	HOOK_OUTPUT_MAX_BYTES,
	type HookRun,
} from "./contracts.ts";
import { errorMessage, isRecord } from "../shared/util.ts";

const RESPONSE_LIMIT = HOOK_OUTPUT_MAX_BYTES;
const stringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseHttpHook(
	value: Record<string, unknown>,
	source: string,
	origin: HookSource | undefined,
	defaultTimeout: number,
	errors: string[],
): HookHttp[] {
	const problems: string[] = [];
	let url: URL | undefined;
	try {
		url = new URL(String(value.url));
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("unsupported URL");
	} catch {
		url = undefined;
		problems.push("HTTP hook requires an http(s) URL without embedded credentials");
	}
	const extra = Object.keys(value).filter(
		(key) =>
			!["type", "url", "headers", "allowedEnvVars", "timeout", "onFailure", "failClosed", "statusMessage"].includes(
				key,
			),
	);
	if (extra.length) problems.push(`unsupported HTTP fields: ${extra.join(", ")}`);
	if (
		value.headers !== undefined &&
		(!isRecord(value.headers) || !Object.values(value.headers).every((item) => typeof item === "string"))
	)
		problems.push("headers must contain strings");
	if (value.allowedEnvVars !== undefined && !stringArray(value.allowedEnvVars))
		problems.push("allowedEnvVars must contain strings");
	if (value.onFailure !== undefined && value.onFailure !== "continue" && value.onFailure !== "block")
		problems.push("invalid onFailure");
	if (
		value.timeout !== undefined &&
		(typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)
	)
		problems.push("timeout must be a positive finite number");
	const failure = problems.join("; ");
	if (failure) errors.push(`${source}: ${failure}`);
	return [
		{
			type: "http",
			protocol: "claude",
			url: url?.href ?? "",
			source,
			headers:
				isRecord(value.headers) && !problems.some((p) => p.startsWith("headers"))
					? (value.headers as Record<string, string>)
					: {},
			allowedEnvVars: stringArray(value.allowedEnvVars) ? value.allowedEnvVars : [],
			timeoutMs:
				(typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0
					? Math.min(value.timeout, HOOK_MAX_TIMEOUT_S)
					: defaultTimeout) * 1000,
			...(value.onFailure === "block" || value.onFailure === "continue" ? { onFailure: value.onFailure } : {}),
			...(value.failClosed === true ? { failClosed: true } : {}),
			...(origin ? { origins: [origin] } : {}),
			...(failure ? { configurationError: failure } : {}),
		},
	];
}

function canonicalPattern(value: string): string {
	// Normalize the host only: paths remain case-sensitive. Wildcards stay literal until matching.
	return value.replace(
		/^(https?:\/\/)([^/]+)(.*)$/i,
		(_all, scheme: string, authority: string, rest: string) =>
			`${scheme.toLowerCase()}${authority.toLowerCase().replace(/\.(?=:|$)/, "")}${rest || (authority.includes("*") ? "" : "/")}`,
	);
}
function matchesUrl(url: string, pattern: string): boolean {
	const escaped = canonicalPattern(pattern)
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`).test(canonicalPattern(url));
}

/** All trusted Claude settings sources contribute to the shared HTTP restrictions. */
export function applyHttpPolicy(config: HookConfig, sources: unknown[], errors: string[]): void {
	const collect = (key: string): string[] | undefined => {
		const values = sources
			.filter(isRecord)
			.filter((source) => key in source)
			.map((source) => source[key]);
		if (!values.length) return undefined;
		if (!values.every(stringArray)) {
			errors.push(`${key} must be an array of strings; HTTP hooks restricted`);
			return [];
		}
		return [...new Set(values.flat())];
	};
	const urls = collect("allowedHttpHookUrls");
	const env = collect("httpHookAllowedEnvVars");
	for (const groups of Object.values(config))
		for (const group of groups)
			for (const hook of group.hooks) {
				if (hook.type !== "http") continue;
				if (urls && !urls.some((pattern) => matchesUrl(hook.url, pattern))) {
					hook.configurationError = "HTTP URL is not allowed by allowedHttpHookUrls";
					errors.push(`${hook.source}: ${hook.configurationError}`);
				}
				if (env) hook.allowedEnvVars = hook.allowedEnvVars.filter((name) => env.includes(name));
			}
}

export async function runHttpHook(
	hook: HookHttp,
	input: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<HookRun> {
	const empty: HookRun = { code: null, stdout: "", stderr: "", timedOut: false };
	if (signal?.aborted) return empty;
	const abort = new AbortController();
	const cancel = () => abort.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, hook.timeoutMs);
	try {
		const environment = { ...process.env, ...env };
		const headers = new Headers();
		for (const [key, value] of Object.entries(hook.headers))
			headers.set(
				key,
				value.replace(
					/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
					(_match, braced: string | undefined, bare: string | undefined) => {
						const name = braced ?? bare!;
						return hook.allowedEnvVars.includes(name) ? (environment[name] ?? "") : "";
					},
				),
			);
		headers.set("Content-Type", "application/json");
		const response = await fetch(hook.url, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
			signal: abort.signal,
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP status ${response.status}`);
		}
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		if (response.body)
			for await (const chunk of response.body) {
				bytes += chunk.byteLength;
				if (bytes > RESPONSE_LIMIT) {
					abort.abort();
					throw new Error("HTTP response exceeds 64 KiB");
				}
				chunks.push(chunk);
			}
		const stdout = Buffer.concat(chunks).toString("utf8");
		if (stdout.trim() && !isRecord(JSON.parse(stdout))) throw new Error("HTTP response must be a JSON object or empty");
		return { ...empty, code: 0, stdout };
	} catch (error) {
		return { ...empty, timedOut, stderr: signal?.aborted ? "" : errorMessage(error) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
