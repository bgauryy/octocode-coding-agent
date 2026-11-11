import {
	type HookConfig,
	type HookHttp,
	type HookSource,
	HOOK_MAX_TIMEOUT_S,
	HOOK_OUTPUT_MAX_BYTES,
	type HookRun,
} from "./contracts.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { isLinkLocalIp, isLoopbackIp, isMetadataIp } from "../../../../common/src/ip-address.ts";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { escapeRegExp } from "../../../../common/src/regexp.ts";
import { bareHostname, pinnedFetch } from "../../../../common/src/web-guard.ts";

const RESPONSE_LIMIT = HOOK_OUTPUT_MAX_BYTES;
const stringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** localhost, 127.0.0.0/8 and ::1: the hosts plain http may reach, because the request never leaves this machine. */
function isLoopbackHost(hostname: string): boolean {
	const host = bareHostname(hostname).toLowerCase().replace(/\.$/, "");
	return host === "localhost" || isLoopbackIp(host);
}

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
	if (url?.protocol === "http:" && !isLoopbackHost(url.hostname))
		problems.push("plain http is allowed only for loopback hosts (localhost, 127.0.0.0/8, ::1); use https");
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
	const escaped = canonicalPattern(pattern).split("*").map(escapeRegExp).join(".*");
	return new RegExp(`^${escaped}$`).test(canonicalPattern(url));
}

/** A loaded Claude settings document and the scope of the file it came from. */
export interface HttpPolicySource {
	scope: HookSource["scope"];
	value: unknown;
}

/**
 * The HTTP restrictions of the trusted Claude settings sources. User files set a list (their lists merge); a project
 * file can only narrow it: a destination or variable must pass the user list and every project list, so a project
 * `*` changes nothing and no project list widens what the user allowed. Without a user list, a project list is the
 * only restriction, which still can only remove destinations from the unrestricted default.
 */
export function applyHttpPolicy(config: HookConfig, sources: HttpPolicySource[], errors: string[]): void {
	const collect = (key: string): string[][] | undefined => {
		let user: string[] | undefined;
		const narrowing: string[][] = [];
		for (const { scope, value } of sources) {
			if (!isRecord(value) || !(key in value)) continue;
			const list = value[key];
			if (!stringArray(list)) {
				errors.push(`${key} must be an array of strings; HTTP hooks restricted`);
				narrowing.push([]);
			} else if (scope === "user") user = [...new Set([...(user ?? []), ...list])];
			else narrowing.push(list);
		}
		const lists = user ? [user, ...narrowing] : narrowing;
		return lists.length ? lists : undefined;
	};
	const urls = collect("allowedHttpHookUrls");
	const env = collect("httpHookAllowedEnvVars");
	for (const groups of Object.values(config))
		for (const group of groups)
			for (const hook of group.hooks) {
				if (hook.type !== "http") continue;
				if (urls && !urls.every((list) => list.some((pattern) => matchesUrl(hook.url, pattern)))) {
					hook.configurationError = "HTTP URL is not allowed by allowedHttpHookUrls";
					errors.push(`${hook.source}: ${hook.configurationError}`);
				}
				if (env) hook.allowedEnvVars = hook.allowedEnvVars.filter((name) => env.every((list) => list.includes(name)));
			}
}

/** Link-local and cloud metadata addresses hand out credentials of the machine or its network; a hook never reaches them. Loopback and private ranges stay allowed for local servers. */
const refuseAddress =
	(host: string) =>
	(address: string): string | undefined =>
		isLinkLocalIp(address) || isMetadataIp(address)
			? `refused: ${host} resolves to ${address}, a link-local or cloud metadata address`
			: undefined;

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
		// Every resolved address is checked and the connection is pinned to them; a redirect answer is never followed.
		const response = await pinnedFetch(
			hook.url,
			{
				method: "POST",
				headers: Object.fromEntries(headers),
				body: JSON.stringify(input),
				redirect: "error",
				signal: abort.signal,
			},
			{ refuse: refuseAddress(new URL(hook.url).host) },
		);
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
		if (stdout.trim()) {
			// A fixed message: the parser's own error quotes the start of the body, which is the server's text.
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				throw new Error("HTTP response is not valid JSON");
			}
			if (!isRecord(parsed)) throw new Error("HTTP response must be a JSON object or empty");
		}
		return { ...empty, code: 0, stdout };
	} catch (error) {
		return { ...empty, timedOut, stderr: signal?.aborted ? "" : redactSecrets(errorMessage(error)) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
