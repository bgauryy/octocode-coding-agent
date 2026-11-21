#!/usr/bin/env node
/**
 * Live check of desktop control through ACP: starts `octocode --mode acp` on a throwaway agent database, asks it to
 * compute 6 x 7 in Calculator, approves only the prompts that name the desktop, then verifies the outcome itself
 * instead of trusting the agent's report. It drives the real desktop and calls a model, so it runs only with `--live`.
 *
 *   node scripts/desktop-acp-check.mjs --live [--bundle packages/coding-agent/dist/bundle/cli.js]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.includes("--live")) {
	console.log("Dry run: this drives your real desktop and calls a model. Add --live to run it.");
	process.exit(0);
}
const bundleAt = args.indexOf("--bundle");
const cli =
	bundleAt >= 0 ? path.resolve(args[bundleAt + 1]) : path.join(repo, "packages/coding-agent/dist/bundle/cli.js");
if (!existsSync(cli)) {
	console.error(`No build at ${cli}: run yarn run build:offline, or pass --bundle.`);
	process.exit(2);
}
if (spawnSync(process.env.OCTOCODE_CUA_DRIVER_PATH || "cua-driver", ["--version"]).status !== 0) {
	console.error("cua-driver is not installed or not on PATH: nothing to check.");
	process.exit(2);
}

const startedAt = Date.now();
const home = mkdtempSync(path.join(tmpdir(), "desktop-acp-check-"));
const env = { ...process.env, OCTOCODE_AGENT_DB: path.join(home, "agent.db") };
const run = (...cliArgs) => spawnSync("node", [cli, ...cliArgs], { cwd: repo, env, encoding: "utf8" });
const trusted = run("trust", "add", "--yes", repo);
if (trusted.status !== 0) {
	console.error(`Could not trust the folder in the throwaway database:\n${trusted.stderr || trusted.stdout}`);
	process.exit(2);
}

const child = spawn("node", [cli, "--mode", "acp"], { cwd: repo, env, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 0;
const pending = new Map();
const asks = [];
const tools = [];
let reply = "";
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const call = (method, params) =>
	new Promise((resolve, reject) => {
		pending.set(++nextId, { resolve, reject });
		send({ jsonrpc: "2.0", id: nextId, method, params });
	});

function handle(message) {
	const waiting = pending.get(message.id);
	if (waiting && (message.result !== undefined || message.error)) {
		pending.delete(message.id);
		return message.error ? waiting.reject(new Error(JSON.stringify(message.error))) : waiting.resolve(message.result);
	}
	if (message.method === "session/request_permission") {
		const toolCall = message.params.toolCall ?? {};
		const allow = /desktop|calculator/i.test(JSON.stringify(toolCall));
		asks.push({ title: toolCall.title ?? "", allow });
		const option = message.params.options.find((entry) => entry.kind === (allow ? "allow_once" : "reject_once"));
		return send({
			jsonrpc: "2.0",
			id: message.id,
			result: { outcome: { outcome: "selected", optionId: (option ?? message.params.options[0]).optionId } },
		});
	}
	const update = message.params?.update;
	if (message.method === "session/update" && update) {
		if (update.sessionUpdate === "agent_message_chunk") reply += update.content?.text ?? "";
		if (update.sessionUpdate === "tool_call") tools.push(update.title ?? update.kind);
	}
}
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
		const line = buffer.slice(0, at);
		buffer = buffer.slice(at + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});

const timeout = setTimeout(() => finish(["timed out after 10 minutes"]), 600_000);
const prompt =
	"Open the Calculator app on this Mac, compute 6 x 7, and tell me what it shows. Include the path of a screenshot " +
	"that proves it, then close Calculator. Do not edit files.";

async function main() {
	await call("initialize", {
		protocolVersion: 1,
		clientCapabilities: {},
		clientInfo: { name: "desktop-acp-check", version: "1" },
	});
	const session = await call("session/new", { cwd: repo, mcpServers: [] });
	await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] });
	const failures = [];
	const check = (ok, what) => {
		if (!ok) failures.push(what);
	};
	check(
		asks.some((entry) => entry.allow && /subagent/i.test(entry.title)),
		"no desktop.control ask reached the client",
	);
	check(
		asks.every((entry) => entry.allow),
		`a prompt that was not about the desktop was refused: ${JSON.stringify(asks)}`,
	);
	check(/\b42\b/.test(reply), "the reply does not report 42");
	// An absolute path, or one relative to the repository (the agent may name either).
	const named = reply.match(/((?:\/|\.\/|\.octocode\/)[^\s`'")]+\.png)/)?.[1];
	const shot = named ? path.resolve(repo, named) : undefined;
	check(Boolean(shot && existsSync(shot)), `the reported screenshot does not exist: ${shot}`);
	check(
		Boolean(shot && existsSync(shot) && statSync(shot).mtimeMs >= startedAt),
		"the reported screenshot is older than this run (a stale file proves nothing)",
	);
	check(
		spawnSync("pgrep", ["-x", "Calculator"]).status !== 0,
		"Calculator is still running (the agent said it closed it)",
	);
	finish(failures, {
		shot,
		asks: asks.length,
		tools: tools.length,
		size: shot && existsSync(shot) ? statSync(shot).size : 0,
	});
}

function finish(failures, facts = {}) {
	clearTimeout(timeout);
	child.kill();
	console.log(
		JSON.stringify(
			{
				ok: failures.length === 0,
				failures,
				...facts,
				...(failures.length > 0 ? { reply: reply.slice(0, 1500) } : {}),
			},
			null,
			2,
		),
	);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => finish([`the ACP session failed: ${error.message}`]));
