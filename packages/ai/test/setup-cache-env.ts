/**
 * Cache retention is read from the process environment when a request does not name it. A subagent inherits its
 * parent's resolved retention that way (`OCTOCODE_INSTRUCTION_CACHE_RETENTION=long`, `OCTOCODE_CACHE_RETENTION=short`),
 * and a developer may export either one. Tests that assert the default markers (no `ttl` on history, a 5-minute
 * OAuth block) then fail only when run from inside such a session. Each test file starts without them; tests that
 * exercise the environment set the variables themselves and restore them.
 */
delete process.env.OCTOCODE_CACHE_RETENTION;
delete process.env.OCTOCODE_INSTRUCTION_CACHE_RETENTION;
delete process.env.OCTOCODE_INSTRUCTION_CACHE_SPLIT;

delete process.env.OCTOCODE_PROMPT_CACHE_KEY;
