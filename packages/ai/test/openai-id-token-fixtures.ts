import { generateKeyPairSync, sign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const openAIJwks = {
	keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }],
};

export function signedOpenAIIdToken(nonce: string, claims: Record<string, unknown> = {}): string {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: "https://auth.openai.com",
			aud: "oaiapp_issued",
			sub: "test-subject",
			exp: Math.floor(Date.now() / 1000) + 3600,
			nonce,
			...claims,
		}),
	).toString("base64url");
	const input = `${header}.${payload}`;
	return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
