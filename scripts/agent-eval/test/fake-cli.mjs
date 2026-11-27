#!/usr/bin/env node
/**
 * Stands in for the agent in the runner's tests: it calls no provider. It takes the flags the real print mode takes and
 * writes transcripts in the real format, as `FAKE_CLI_SCENARIO` (a JSON file) describes.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const scenario = JSON.parse(readFileSync(process.env.FAKE_CLI_SCENARIO, "utf8"));

if (scenario.envDump) writeFileSync(scenario.envDump, JSON.stringify({ env: process.env, cwd: process.cwd(), args }));
if (scenario.exitWithoutTranscript) process.exit(1);

const assistant = (content, cost, extra = {}) => ({
	type: "message",
	message: {
		role: "assistant",
		model: scenario.model ?? "fake-main",
		stopReason: "stop",
		content,
		usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5, cost: { total: cost } },
		...extra,
	},
});
const line = (file, entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`);

for (const [path, text] of Object.entries(scenario.writes ?? {})) writeFileSync(path, text);

const sessions = flag("--session-dir");
mkdirSync(sessions, { recursive: true });
const main = join(sessions, "main.jsonl");
line(main, { type: "session", id: "main" });
line(main, { type: "message", message: { role: "user", content: flag("-p") } });

for (const child of scenario.children ?? []) {
	const state = scenario.baseline ? join(".octa", "code") : join(".octocode", "agent");
	const dir = join(state, "temp", "agents", child.name, "session");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "child.jsonl");
	line(file, {
		type: "message",
		message: {
			role: "user",
			content: `## You\nYour name is \`${child.name}\` (${child.role}). You work for \`main\`.`,
		},
	});
	line(
		file,
		assistant([{ type: "toolCall", name: "bash", arguments: { command: "rg foo src" } }], child.cost, {
			model: child.model,
		}),
	);
	line(file, assistant([{ type: "text", text: "done: report" }], child.cost, { model: child.model }));
}

const requests = scenario.requests ?? 2;
for (let index = 0; index < requests - 1; index++) {
	line(
		main,
		assistant(
			[
				{ type: "toolCall", name: "mcp__octocode__localSearch", arguments: { queries: [] } },
				{ type: "toolCall", name: "bash", arguments: { command: "cat package.json" } },
			],
			scenario.costPerRequest ?? 0.01,
		),
	);
	if (scenario.sleepMs) await sleep(scenario.sleepMs);
}
line(main, assistant([{ type: "text", text: scenario.answer ?? "" }], scenario.costPerRequest ?? 0.01));
console.log(scenario.answer ?? "");
