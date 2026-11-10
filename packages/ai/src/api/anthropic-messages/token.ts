/** Whether an Anthropic credential is a Claude subscription token (`claude setup-token`) rather than an API key. */
export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}
