/**
 * Refused credentials: an HTTP 401/403, an invalid, expired or revoked key or token, or a sign-in whose OAuth refresh
 * the vendor refused (`invalid_grant`: signed out elsewhere, expired or revoked).
 */
const CREDENTIAL_ERROR =
	/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|api[ _-]?key|credential|permission[ _]denied|expired|oauth refresh failed|invalid_grant/i;

const INVALID_CREDENTIAL =
	/\b401\b|invalid_grant|(?:invalid|incorrect|expired|revoked)[ _-]+(?:api[ _-]?key|token|credentials?)|(?:api[ _-]?key|token|credentials?)[ _-]+(?:(?:is|has)[ _-]+)?(?:invalid|incorrect|expired|revoked)/i;

/**
 * Whether provider error text says the credential was refused, so every model of that provider fails the same way.
 * A 403 can deny one model while accepting the same credential for another; explicit invalid credentials still win.
 */
export function isCredentialError(text: string): boolean {
	if (INVALID_CREDENTIAL.test(text)) return true;
	const modelAccess =
		/\b403\b/.test(text) &&
		/\bmodel\b/i.test(text) &&
		/\b(?:access|available|enabled)\b/i.test(text) &&
		/\b(?:not|no|denied|restricted|forbidden)\b/i.test(text);
	return !modelAccess && CREDENTIAL_ERROR.test(text);
}
