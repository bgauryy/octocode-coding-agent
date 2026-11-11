import { providerKeyNames } from "../../utils/shell.ts";
import { runnerSpec } from "./runners.ts";

/**
 * Key variables an agent CLI reads in place of its own sign-in. `CODEX_API_KEY` is in no provider table; the other two
 * are provider keys `providerKeyNames` also finds, listed so this names every key an agent CLI reads.
 */
const AGENT_CREDENTIALS = ["CODEX_API_KEY", "OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN"];
/** Every Anthropic variable: a key, a token or a base URL would route Claude Code around the user's own login. */
const ANTHROPIC = /^ANTHROPIC_/;
/** This process's own variables (team identity, permission handoff files, internal flags); the Octocode home is the user's. */
const OCTOCODE_INTERNAL = /^OCTOCODE_(?!HOME$)/;

/**
 * The environment an external agent (an ACP adapter, or a runner's own CLI) starts with: this process's, without the
 * provider credentials the shell also removes (`providerKeyNames`), every `ANTHROPIC_*` variable, the agent CLIs' own
 * key variables and Octocode's internal ones. An inherited API key would otherwise bill in place of the plan the agent
 * is signed in with. A runner's own configuration (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, a `CLAUDE_CODE_OAUTH_TOKEN` the
 * user exported) passes.
 */
export function agentEnv(vendor: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const keep = new Set(runnerSpec(vendor)?.keep);
	const removed = new Set([...providerKeyNames(env), ...AGENT_CREDENTIALS]);
	const clean: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const drop = removed.has(name) || ANTHROPIC.test(name) || OCTOCODE_INTERNAL.test(name);
		if (!drop || keep.has(name)) clean[name] = value;
	}
	return clean;
}
