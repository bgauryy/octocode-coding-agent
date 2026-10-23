// A suite started from inside Octocode (or one of its subagents) inherits that session's OCTOCODE_* identity and
// settings (OCTOCODE_SUBAGENT, OCTOCODE_CACHE_RETENTION, ...): drop them so results never depend on who ran the tests.
// The values configured in vitest.config.ts (`test.env`) are the suite's own and stay.
const configured = new Set(["OCTOCODE_OFFLINE", "OCTOCODE_MCP", "OCTOCODE_MODELS_DEV", "OCTOCODE_API"]);
for (const name of Object.keys(process.env)) {
	if (name.startsWith("OCTOCODE_") && !configured.has(name)) delete process.env[name];
}
