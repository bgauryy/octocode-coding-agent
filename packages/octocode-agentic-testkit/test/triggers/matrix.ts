/** One should-fire and one near-miss prompt per bundled skill; the near-miss shares vocabulary but not the task. */
export const PROMPTS: Record<string, { fire: string; nearMiss: string }> = {
	"octocode-backlog-grooming": {
		fire: "Groom our backlog: close the stale or duplicate items and reprioritize the rest.",
		nearMiss: "Add a single new task to the backlog titled 'update README'.",
	},
	"octocode-context-optimization": {
		fire: "Our skill listings and MCP tool files are huge. Shrink the skill descriptions.",
		nearMiss: "List the skills that are installed.",
	},
	"octocode-debugging": {
		fire: "My Node service hangs under load. Attach a debugger, find the deadlock and profile the CPU.",
		nearMiss: "Explain what a deadlock is in two sentences.",
	},
	"resume-external-harness": {
		fire: "Find my last Claude Code session in this repo and give me the command to resume it.",
		nearMiss: "What is Claude Code?",
	},
	"octocode-agentic": {
		fire: "Review my LLM agent design: its prompts, memory, tool contracts and evals.",
		nearMiss: "Write a haiku about robots.",
	},
	"octocode-brainstorming": {
		fire: "Brainstorm three alternatives to Redis for our cache and compare competitors with sources.",
		nearMiss: "Which Redis command deletes a key?",
	},
	"octocode-chrome-devtools": {
		fire: "Open my logged-in dashboard in Chrome, click Export and capture the console errors and network requests.",
		nearMiss: "What does the Chrome DevTools Network tab show?",
	},
	"octocode-clean-agentic-code": {
		fire: "Remove the dead code, unused exports and leftover debug logs from this repo without changing behavior.",
		nearMiss: "What does the term 'dead code' mean?",
	},
	"octocode-documentation": {
		fire: "Rewrite the README so a new user can install and run the tool; check the commands.",
		nearMiss: "Rename the function parseUrl to parseURL in src/url.ts.",
	},
	"octocode-engineer": {
		fire: "Design the storage and caching layer for a high-throughput event pipeline: sync vs async, backpressure, throttling.",
		nearMiss: "What port does PostgreSQL use by default?",
	},
	"octocode-graph": {
		fire: "Who imports packages/db/src/api.ts? Show the dependency path and any import cycles.",
		nearMiss: "Draw an ASCII bar chart of 3, 5 and 8.",
	},
	"octocode-graph-view": {
		fire: "Give me an interactive visual map of this repository's architecture to explore.",
		nearMiss: "Describe a graph data structure.",
	},
	"octocode-messages-proxy": {
		fire: "Relay this message to the Codex CLI agent through a small-model proxy and return its reply: 'status of the build?'",
		nearMiss: "Summarize what a message queue is.",
	},
	"octocode-orchestrator": {
		fire: "Coordinate three agents on this task: assign work, track dependencies and recover any stalled one.",
		nearMiss: "What is the orchestrator pattern in microservices, briefly?",
	},
	"octocode-pr-review": {
		fire: "Review GitHub pull request #482 and give an APPROVE, COMMENT or REQUEST_CHANGES verdict.",
		nearMiss: "Review my uncommitted local changes for typos.",
	},
	"octocode-research": {
		fire: "How does the session manager in this repo persist sessions, and who calls it?",
		nearMiss: "How do JavaScript closures work?",
	},
	"octocode-rfc-generator": {
		fire: "Write an RFC for migrating our job queue to a new broker, with tasks, validation and rollout.",
		nearMiss: "What does RFC 2616 define?",
	},
	"octocode-roast": {
		fire: "Roast this code brutally: give me a harsh teardown of src/server.ts.",
		nearMiss: "Give me gentle, friendly feedback on src/server.ts naming.",
	},
	"octocode-scraping": {
		fire: "Extract the price table from https://example.com/pricing and crawl the docs site into a saved corpus.",
		nearMiss: "Is web scraping legal? One paragraph.",
	},
	"octocode-skills": {
		fire: "Create a new Agent Skill with a SKILL.md and improve its trigger description.",
		nearMiss: "What are your strongest skills as a coding assistant?",
	},
	"octocode-test-plan": {
		fire: "Write a runnable test plan for this pull request: setup, actions, expected results and pass rules.",
		nearMiss: "Write a unit test for add(a, b).",
	},
	"octocode-workflows": {
		fire: "Design a release pipeline with ordered stages, retries, checkpoints and rollback.",
		nearMiss: "What does 'git rebase' do?",
	},
};

export const UNRELATED = ["What is the capital of France?", "Translate 'good morning' into Spanish."];
