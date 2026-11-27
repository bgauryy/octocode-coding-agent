/**
 * Refused credentials: an HTTP 401, a key, token or credential named as invalid, incorrect, expired, revoked or missing,
 * a credential chain's own refusal (AWS SSO, google-auth, the AWS CLI, GitHub), or a sign-in whose OAuth refresh the
 * vendor refused (`invalid_grant`: signed out elsewhere, expired or revoked) or that must be made again. A bare
 * 403, "forbidden" or "permission denied" counts only when the text names a key, a token or authentication: a 403 that
 * names neither (a region, a model, a policy) is the account's or the request's, not the credential's.
 */

/** What is wrong with a credential, as providers word it. */
const BAD = String.raw`(?:invalid|incorrect|expired|revoked|not valid)`;
const KEY = String.raw`(?:x-)?api[ _-]?key`;
/** The kind of a token that is a credential; a bare "token" may also count tokens ("missing token count"). */
const TOKEN_KIND = String.raw`(?:access|refresh|bearer|oauth|auth|security|session|id)`;
const CREDENTIALS = String.raw`(?:authentication[ _-])?credentials?`;
/** A word naming a credential: an API key, a token (access, refresh, bearer, OAuth, ID), or credentials. Not "tokens". */
const CREDENTIAL = String.raw`(?:${KEY}|${TOKEN_KIND}?[ _-]?token(?!s)|${CREDENTIALS})`;
/** A credential named as one, which alone can be said to be missing. */
const NAMED_CREDENTIAL = String.raw`(?:${KEY}|${TOKEN_KIND}[ _-]?token(?!s)|${CREDENTIALS})`;
/** An HTTP status code standing alone: not digits inside a larger number, an index or an id. */
const status = (code: string) => String.raw`(?<![A-Za-z0-9.])${code}(?![A-Za-z0-9]|\.\d)`;

/** A definite refusal of the credential: a model-access refusal never outweighs it. */
const INVALID_CREDENTIAL = new RegExp(
	[
		status("401"),
		"invalid_grant",
		"authentication_error",
		"oauth refresh failed",
		// "Incorrect API key provided", "invalid x-api-key", "invalid_api_key", "ExpiredTokenException",
		// "Request had invalid authentication credentials".
		`${BAD}[ _-]*${CREDENTIAL}`,
		`missing[ _-]*${NAMED_CREDENTIAL}`,
		// "API key not valid", "API_KEY_INVALID", "Token is expired", "OAuth token has expired", "refresh token has been
		// revoked", "The API key you provided is not valid".
		String.raw`(?<![A-Za-z0-9_])${CREDENTIAL}(?: you provided)?[ _-]+(?:(?:is|are|was|were|has|have)[ _-]+)?(?:been[ _-]+)?${BAD}`,
		String.raw`(?<![A-Za-z0-9_])${NAMED_CREDENTIAL}[ _-]+(?:(?:is|are|was|were)[ _-]+)?missing`,
		// AWS STS: "The security token included in the request is invalid" (UnrecognizedClientException) or "is expired".
		`security token included in the request is ${BAD}`,
		// AWS SSO: "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO
		// session run aws sso login ...", also "is invalid" and "token ... was not found or is invalid".
		String.raw`\bSSO session\b[^.\n]*?\b(?:expired|invalid)\b`,
		String.raw`\baws sso login\b`,
		// GitHub (Copilot's token exchange): `{"message":"Bad credentials"}`. Google: "Request had insufficient
		// authentication scopes". AWS: "... Check your AWS Secret Access Key and signing method".
		String.raw`\bbad credentials\b`,
		String.raw`\binsufficient authentication scopes\b`,
		String.raw`\bcheck your AWS secret access key\b`,
		// "Invalid authentication"; DeepSeek: "Authentication Fails, Your api key: ****abcd is invalid".
		String.raw`\binvalid[ _]authentication\b`,
		String.raw`\bauthentication fail(?:s|ed)\b`,
		// Sign in with ChatGPT: "...; reconnect ChatGPT". Claude Code: "Not logged in · Please run /login".
		String.raw`\breconnect ChatGPT\b`,
		String.raw`\bnot logged in\b`,
		// OpenAI: "your refresh token was already used", "Your refresh token has already been used", `refresh_token_reused`.
		String.raw`\brefresh[ _-]?token[ _-](?:(?:was|has|is)[ _-])?(?:already[ _-])?(?:been[ _-])?(?:re)?used\b`,
		// OpenAI: "You didn't provide an API key"; Anthropic: "x-api-key header is required".
		String.raw`\b(?:did not|didn.t) provide an? ${KEY}`,
		String.raw`\b${KEY}(?: header)? is required\b`,
	].join("|"),
	"i",
);

/** A refused or absent credential in other words; a model-access refusal that uses them is the model's, not the key's. */
const CREDENTIAL_REFUSED = new RegExp(
	[
		"unauthori[sz]ed",
		// AWS SSO: "Your session has expired. Please reauthenticate.", "The SSO session ... has expired".
		"re-?authenticate",
		String.raw`\bsession (?:has |is )?expired\b`,
		// OpenRouter: "No auth credentials found"; AWS SDK: "Could not load credentials from any providers"; google-auth:
		// "Could not load the default credentials"; AWS CLI: "Unable to locate credentials".
		String.raw`\bno[ _-]+(?:auth[ _-]+)?(?:api[ _-]?key|credentials?)\b`,
		String.raw`\b(?:could ?not|couldn't|unable to|failed to) (?:load|find|resolve|locate) (?:the )?(?:default )?credentials\b`,
		// "Please log out and sign in again", "sign in with ChatGPT again", "Please try signing in again".
		String.raw`\b(?:sign(?:ing)?|log(?:ging)?)[ -]?in(?: with [\w-]+)? again\b`,
	].join("|"),
	"i",
);

/** A refusal that may be the credential's or the account's; it is the credential's only when the text names one. */
const FORBIDDEN = new RegExp(`${status("403")}|forbidden|permission[ _]denied`, "i");
const NAMES_CREDENTIAL = /api[ _-]?key|\bkey\b|token(?!s)|authenticat|credential/i;

/** What the provider rejected about a model at this account and endpoint. */
export function modelAccessIssue(text: string): "identifier" | "account" | "profile" | undefined {
	if (INVALID_CREDENTIAL.test(text)) return undefined;
	if (
		/\bmodel_not_found\b|\binvalid model id(?:entifier)?\b|\bmodel id(?:entifier)? (?:provided )?is invalid\b/i.test(
			text,
		) ||
		/\bmodel(?:\s+[^\s,;]+)? (?:was |is )?(?:not found|does not exist)\b/i.test(text)
	)
		return "identifier";
	if (/\bon.demand throughput (?:isn.t|is not) supported\b/i.test(text)) return "profile";
	if (
		/\b[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_:.-]*)+ is not available for (?:this|your) account\b/i.test(text) ||
		/\b(?:model|inference profile)(?:\s+[^\s,;]+)? (?:is )?(?:not (?:available|enabled|supported)|unavailable) (?:for|to|in) (?:this|your|the) (?:account|region|endpoint)\b/i.test(
			text,
		) ||
		/\baccount (?:is not|isn.t) (?:authorized|approved|eligible) (?:for|to (?:access|use)) (?:this |the )?model\b/i.test(
			text,
		) ||
		/\b(?:(?:no access|(?:do not|don.t) have access) to|not authorized to access) (?:(?:this|the|that|requested|specified) )?model\b|\baccess to (?:this|the|that) model (?:is |has been )?denied\b/i.test(
			text,
		)
	)
		return "account";
	return undefined;
}

/** A refusal tied to this model or inference profile. Other models can use the same credential. */
export function isModelAccessError(text: string): boolean {
	return modelAccessIssue(text) !== undefined;
}

/** A 403 can deny one model while accepting the same credential for its siblings. */
export function isCredentialError(text: string): boolean {
	if (INVALID_CREDENTIAL.test(text)) return true;
	if (isModelAccessError(text)) return false;
	return CREDENTIAL_REFUSED.test(text) || (FORBIDDEN.test(text) && NAMES_CREDENTIAL.test(text));
}
