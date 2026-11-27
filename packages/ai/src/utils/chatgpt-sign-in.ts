/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
export function isChatGPTSignIn(model: { provider: string; baseUrl: string }, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}
