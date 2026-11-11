/**
 * CLI help display
 */

import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../config.ts";
import { flagHelpRows } from "./flags.ts";

export function printHelp(): void {
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with native Octocode tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [--] [@files...] [messages...]

Inside a session, ${chalk.bold("/help")} lists the slash commands.

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install a package (skills, prompts, themes) and add it to settings
  ${APP_NAME} remove <source> [-l]      Remove a package from settings
  ${APP_NAME} update [source|self]      Update Octocode, packages, or model catalogs
  ${APP_NAME} list                      List installed packages from settings
  ${APP_NAME} configuration [verb]      List, enable, disable, set or add configuration (--local, --json)
  ${APP_NAME} auth <command>            Print credentials or check provider readiness
  ${APP_NAME} models discover           Compare vendor model IDs with the local catalog
  ${APP_NAME} mcp <command>             Configure MCP servers, check status, or sign in
  ${APP_NAME} trust <list|add|remove>   Show, grant or revoke folder trust
  ${APP_NAME} profile [--insights]      Show where a session's requests, cache and waits went
  ${APP_NAME} remote <list|link|stop>   List sessions the web daemon reaches; publish or stop a remote link
  ${APP_NAME} context <command>         Show and store the skill descriptions agents read
  ${APP_NAME} marketplace <command>     Add, list, update or remove plugin marketplaces (path, owner/repo, git URL)
  ${APP_NAME} plugin <command>          Install, update or remove plugins from a marketplace (plugin@marketplace)
  ${APP_NAME} completion <bash|zsh|fish> Print shell completion setup
  ${APP_NAME} <command> --help          Show command-specific help

${chalk.bold("Options:")}
${flagHelpRows().join("\n")}
${"  --".padEnd(33)}End option parsing; treat remaining arguments as messages/files


${chalk.bold("Examples:")}
  # Print a provider API key for an external client
  ${APP_NAME} auth print-api-key --provider openai

  # Print an OAuth bearer token for an external client (refreshes if expired)
  ${APP_NAME} auth print-bearer-token --provider openai-codex

  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Delegate one task without reading a parent's open stdin (pre-trusted folder)
  ${APP_NAME} -p --no-stdin --no-session --permission-mode workspace "Review this project without editing files"

  # Stream JSON Lines events, not a single JSON document
  ${APP_NAME} --mode json --no-stdin --permission-mode workspace "Run tests and report failures"

  # Persistent worker. Keep stdin open until completion; --no-dialogs refuses asks
  ${APP_NAME} --mode rpc --no-dialogs --permission-mode workspace

  # Configure provider credentials first; --trust records folder trust, not a sandbox
  # Text/JSON: check exit status. RPC: check the completed run's outcome.

  # Prompt beginning with a dash
  ${APP_NAME} -p -- "- Summarize these points"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Start a named session
  ${APP_NAME} --name "Refactor auth module"

  # Use a specific model (provider/id)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Run headless with a model and a permission mode (subagents inherit the mode)
  ${APP_NAME} --model anthropic/claude-sonnet-4-5:medium --permission-mode workspace -p "Fix the failing test"

  # Run with no permission prompts at all, e.g. in a disposable container (still audited)
  ${APP_NAME} --dangerously-skip-permissions -p "Upgrade the dependencies"

  # Allow one MCP tool by its full name
  ${APP_NAME} --tools 'mcp__docs__search' -p "Find the retry settings"

  # Limit native tools to one MCP server
  ${APP_NAME} --tools bash,'mcp__github__*'

  # Disable one tool while keeping the rest available
  ${APP_NAME} --exclude-tools askUser

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/octocodecode/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_AUTH_TOKEN             - Anthropic bearer auth token
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Claude subscription token: refused (connect Claude Code in /providers)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  BASETEN_API_KEY                  - Baseten API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  META_API_KEY                     - Meta Model API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  QWEN_TOKEN_PLAN_API_KEY          - Qwen Token Plan API key (international region)
  QWEN_TOKEN_PLAN_CN_API_KEY       - Qwen Token Plan API key (China region)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/octocodecode)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  OCTOCODE_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  OCTOCODE_OFFLINE                       - Disable startup network operations when set to 1/true/on/yes
  OCTOCODE_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  OCTOCODE_SHARE_VIEWER_URL              - Base URL for /share command (default: GitHub gist)

${chalk.bold("Built-in Tool Names:")}
  bash       - Execute commands (type: bash or powershell)
  file       - Guarded file edits, writes and deletions
  backlog    - Work a backlog item: read, claim, note, finish, close
  backlogPlan - Add, edit and list backlog items
  archive    - Recall session history, compaction summaries and lifecycle events
  memory     - Save, search and read workspace memories
  web        - Search and fetch public web content
  agent      - Task, external-agent, coordination and message modes
  askUser    - Ask structured questions
  skill      - Load a listed skill's instructions
  compact    - Ask for the conversation to be summarized (main session)
  models     - Show the session model, providers and the models a task can run on (main session)
  mcp        - Inspect, stop or restart MCP servers

Tool availability follows session mode and selection. Enabled MCP servers provide
additional tools; mcp manages servers.

--exclude-tools and --no-mcp also bind subagents. --tools is this session's allowlist
only: a subagent keeps the tools of its profile.
`);
}
