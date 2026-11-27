// SDKs append their operation path; Google expects its API version in the base URL.
// https://opencode.ai/v2/docs/console/models/
// https://opencode.ai/v2/docs/console/go/
const API_PATHS: Record<string, string> = {
	"openai-responses": "openai/v1",
	"openai-completions": "openai/v1",
	"anthropic-messages": "anthropic",
	"google-generative-ai": "google/v1beta",
	"typesafe-system-one": "systemone/v1",
};

export function getOpenCodeBaseUrl(provider: "opencode" | "opencode-go", api: string): string {
	const path = API_PATHS[api];
	if (!path) throw new Error(`Unsupported OpenCode API: ${api}`);
	return `https://opencode.ai/inference/${provider === "opencode-go" ? "go/" : ""}${path}`;
}
