import type { AssistantMessage, AuthResult } from "@octocodeai/octocode-ai";
import { isCredentialError } from "@octocodeai/octocode-ai";
import { APP_NAME } from "../../config.ts";
import { authGuidanceSurface } from "../auth-guidance.ts";
import type { ModelRuntime } from "../model-runtime.ts";

const BEDROCK = "amazon-bedrock";

/** An STS rejection that isCredentialError does not match by wording. */
const BEDROCK_REJECTED_TOKEN = /UnrecognizedClientException|security token included in the request is invalid/i;

/** What starts the line a credential failure ends with, for the person at this session. */
const FIX_MARKER = "\nFix: ";
const FIX_LINES = new RegExp(`${FIX_MARKER}[^\n]*`, "g");

/**
 * The failure without its `Fix:` lines, for a reader that can run none of them (a parent model reading its child's
 * failure): it keeps the provider and model the failure names.
 */
export function withoutCredentialFix(text: string): string {
	return text.replace(FIX_LINES, "");
}

/** The Bedrock credential lookup runs inside the reply's end event: a slow one leaves the generic fix. */
const AUTH_LOOKUP_MS = 2_000;

/**
 * The login command of each provider that runs through its vendor's own CLI (`ProviderPlan.transport: "cli"`), as
 * `octocode/external/runners.ts` defines it. `core/` must not import that layer; a test keeps the two equal.
 */
export const CLI_LOGIN: Readonly<Record<string, string>> = { "claude-code": "claude auth login" };

export type CredentialFixRuntime = Pick<ModelRuntime, "getAuth" | "getProvider" | "getProviderKind">;

/**
 * `aws sso login`, with `--profile` when Bedrock signs in through a named profile; undefined for a bearer token,
 * static keys, a role or an unknown chain, which that command does not renew.
 */
async function awsSsoLogin(runtime: CredentialFixRuntime, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const signal = AbortSignal.timeout(AUTH_LOOKUP_MS);
	let auth: AuthResult | undefined;
	try {
		auth = await runtime.getAuth(BEDROCK, { signal });
	} catch (error) {
		if (signal.aborted) return undefined;
		throw error;
	}
	if (!auth || auth.auth.apiKey) return undefined;
	const profile =
		auth.env?.AWS_PROFILE?.trim() || (auth.source === "AWS_PROFILE" ? env.AWS_PROFILE?.trim() : undefined);
	if (profile) return `aws sso login --profile ${profile}`;
	return auth.source === "AWS shared configuration" ? "aws sso login" : undefined;
}

/**
 * What the `Fix:` line that ends a credential failure says: the vendor CLI's own login for a provider that runs through it, `aws sso
 * login` for Bedrock signed in through a profile, and the provider's `/providers` page otherwise. A headless run's
 * reader is at a shell, so it is told to open that page in Octocode and to pick a model with `--model`.
 */
async function credentialFix(provider: string, runtime: CredentialFixRuntime, env: NodeJS.ProcessEnv): Promise<string> {
	const cli = authGuidanceSurface() === "cli";
	const name = runtime.getProvider(provider)?.name ?? provider;
	const page = cli ? `run \`${APP_NAME}\` and open /providers → ${name}` : `/providers → ${name}`;
	if (runtime.getProviderKind(provider) === "CLI") {
		const login = CLI_LOGIN[provider];
		return login ? `run \`${login}\`` : page;
	}
	const sso = provider === BEDROCK ? await awsSsoLogin(runtime, env) : undefined;
	const switchModel = cli ? "pick another model with --model" : "switch model with /model";
	return sso ? `run \`${sso}\`, ${switchModel}, or ${page}` : page;
}

/**
 * A failed reply whose error is a credential problem names its provider and model, so the user sees which default to
 * fix instead of a bare SDK message, and ends with the fix. Edits the message in place before it is shown or saved.
 */
export async function explainCredentialError(
	message: AssistantMessage,
	runtime: CredentialFixRuntime,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const text = message.errorMessage;
	if (message.stopReason !== "error" || !text || text.includes(FIX_MARKER)) return;
	const bedrockToken = message.provider === BEDROCK && BEDROCK_REJECTED_TOKEN.test(text);
	if (!bedrockToken && !isCredentialError(text)) return;
	const named = text.toLowerCase().includes(message.provider.toLowerCase())
		? text
		: `${message.provider}/${message.model}: ${text}`;
	message.errorMessage = `${named}${FIX_MARKER}${await credentialFix(message.provider, runtime, env)}`;
}
