#!/usr/bin/env node
// Usage: node scripts/run-tier.mjs <haiku|deepseek|local> -- <command...>
// Fills TESTKIT_TIER and TESTKIT_<TIER>_BASE_URL/_KEY/_MODEL for the child from the user's models.json
// (providers anthropic-custom -> haiku, tokenlab -> deepseek). The key goes only into the child's env.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCES = {
	haiku: { provider: "anthropic-custom", model: "claude-haiku-5-5" },
	deepseek: { provider: "tokenlab", model: "DeepSeek-V4-Flash" },
};
const [tier, sep, ...cmd] = process.argv.slice(2);
if (!tier || (sep !== "--" && tier !== "local") || (tier !== "local" && !cmd.length)) {
	console.error("usage: run-tier.mjs <haiku|deepseek|local> -- <command...>");
	process.exit(2);
}
const env = { ...process.env, TESTKIT_TIER: tier };
const src = SOURCES[tier];
if (src) {
	const file = process.env.TESTKIT_MODELS_JSON ?? join(homedir(), ".octocode", "octocodecode", "models.json");
	const p = JSON.parse(readFileSync(file, "utf8")).providers?.[src.provider];
	if (!p?.baseUrl || !p.apiKey) {
		console.error(`models.json has no usable provider ${src.provider} (baseUrl and apiKey)`);
		process.exit(2);
	}
	const pre = `TESTKIT_${tier.toUpperCase()}_`;
	env[`${pre}BASE_URL`] = p.baseUrl;
	env[`${pre}KEY`] = p.apiKey;
	env[`${pre}MODEL`] ??= src.model;
	console.error(`tier ${tier}: ${p.baseUrl} model ${env[`${pre}MODEL`]} (key from models.json, not shown)`);
}
const child = spawn(cmd[0], cmd.slice(1), { env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
