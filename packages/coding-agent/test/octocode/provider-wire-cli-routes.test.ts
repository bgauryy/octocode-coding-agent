import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns, writeSettings } from "./e2e-real-process-harness.ts";
import { wireBox } from "./provider-wire-box.ts";
import { tmp } from "./helpers.ts";

/**
 * The external CLI routes /model offers, chosen with `--model <route>/default` in a real session: the vendor's ACP
 * server is a stand-in program on PATH (the scripted ACP peer), so the turn goes through the route's real transport and
 * a loopback-only process. Codex and Claude Code have their own suites (cli-models-builtins, e2e-claude-code).
 */
vi.setConfig({ testTimeout: 180_000 });

const PEER = fileURLToPath(new URL("./fixtures/claude-code-peer.mjs", import.meta.url));

afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
});

/** [route provider id, the program its ACP server starts] */
const ROUTES = [
	["gemini-cli", "gemini"],
	["opencode-cli", "opencode"],
	["agy-cli", "agy"],
] as const;

describe.each(ROUTES)("the %s route", (route, program) => {
	it("answers one turn through the vendor's ACP server, with no network", async () => {
		const journal = path.join(tmp("octocode-route-journal-"), "journal.jsonl");
		const script = JSON.stringify({ prompts: [[{ say: `Hello from ${program}.` }]] });
		const bin = tmp("octocode-route-bin-");
		fs.writeFileSync(
			path.join(bin, program),
			`#!/bin/sh\nexec '${process.execPath}' '${PEER}' '${journal}' '${script}'\n`,
			{ mode: 0o755 },
		);
		const box = wireBox();
		box.env.PATH = `${bin}:${process.env.PATH}`;
		writeSettings(box, { externalAgents: true, enabledExternalAgents: [program] });
		const result = await box.prompt(`${route}/default`, "say hello to the route");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(`Hello from ${program}.`);
		const prompts = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === "prompt");
		expect(prompts).toHaveLength(1);
		expect(prompts[0].text).toContain("say hello to the route");
		expect(box.violations()).toEqual([]);
	});
});
