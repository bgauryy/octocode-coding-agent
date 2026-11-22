/**
 * Refused credentials: an HTTP 401/403, an invalid, expired or revoked key or token, or a sign-in whose OAuth refresh
 * the vendor refused (`invalid_grant`: signed out elsewhere, expired or revoked).
 */
const CREDENTIAL_ERROR =
	/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|api[ _-]?key|credential|permission[ _]denied|expired|oauth refresh failed|invalid_grant/i;

const INVALID_CREDENTIAL =
	/\b401\b|invalid_grant|(?:invalid|incorrect|expired|revoked)[ _-]+(?:api[ _-]?key|token|credentials?)|(?:api[ _-]?key|token|credentials?)[ _-]+(?:(?:is|has)[ _-]+)?(?:invalid|incorrect|expired|revoked)/i;

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
	return INVALID_CREDENTIAL.test(text) || (CREDENTIAL_ERROR.test(text) && !isModelAccessError(text));
}
