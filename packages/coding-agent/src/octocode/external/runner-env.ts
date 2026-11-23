import { AWS_BEARER_TOKEN_BEDROCK_ENV, PROVIDER_TOKEN_ENV_VARS } from "@octocodeai/octocode-ai/compat";
import { providerKeyNames } from "../../utils/shell.ts";
import { runnerSpec } from "./runners.ts";

/**
 * Known agent credentials, including vendor-owned token and header configuration. A runner keeps its own declared
 * configuration; other runners never inherit those credentials.
 */
const AGENT_CREDENTIALS = [
	"CODEX_API_KEY",
	"OPENAI_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"GEMINI_CLI_CUSTOM_HEADERS",
];
/**
 * Provider tokens outside the API-key table that the shell removes (`PROVIDER_TOKEN_ENV_VARS`), less the one agent CLIs
 * read for their own Bedrock setup: Claude Code (`CLAUDE_CODE_USE_BEDROCK=1`) and Codex's Bedrock provider both
 * authenticate with `AWS_BEARER_TOKEN_BEDROCK` (code.claude.com/docs/en/amazon-bedrock, Codex's Amazon Bedrock page),
 * so it is the user's AWS credential like `AWS_PROFILE` and passes. `OPENAI_CUSTOM_HEADERS` is only Octocode's OpenAI
 * client's, and no runner documents reading it.
 */
const PROVIDER_TOKENS = PROVIDER_TOKEN_ENV_VARS.filter((name) => name !== AWS_BEARER_TOKEN_BEDROCK_ENV);
/** Every Anthropic variable: a key, a token or a base URL would route Claude Code around the user's own login. */
const ANTHROPIC = /^ANTHROPIC_/;
/** This process's own variables (team identity, permission handoff files, internal flags); the Octocode home is the user's. */
const OCTOCODE_INTERNAL = /^OCTOCODE_(?!HOME$)/;

/**
 * The environment an external agent (an ACP adapter, or a runner's own CLI) starts with: this process's, without the
 * provider credentials the shell also removes (`providerKeyNames`, `PROVIDER_TOKENS`), every `ANTHROPIC_*` variable, the agent CLIs' own
 * key variables and Octocode's internal ones. An inherited API key would otherwise bill in place of the plan the agent
 * is signed in with. A runner's own configuration (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, a `CLAUDE_CODE_OAUTH_TOKEN` the
 * user exported) passes.
 */
export function agentEnv(vendor: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const keep = new Set(runnerSpec(vendor)?.keep);
	const removed = new Set([...providerKeyNames(env), ...PROVIDER_TOKENS, ...AGENT_CREDENTIALS]);
	const clean: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const drop = removed.has(name) || ANTHROPIC.test(name) || OCTOCODE_INTERNAL.test(name);
		if (!drop || keep.has(name)) clean[name] = value;
	}
	return clean;
}
