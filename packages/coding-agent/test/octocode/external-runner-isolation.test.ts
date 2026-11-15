import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { runnerTurn } from "../../src/octocode/external/runner-session.ts";
import { withCommunicationConfig, checkRunnerCommunication } from "../../src/octocode/external/runner-communication.ts";
import { runnerLaunchArgs } from "../../src/octocode/external/runner-isolation.ts";
import { sessionMeta } from "../../src/octocode/claude-code/launch.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

it("starts a Claude ACP runner with ambient skills and MCP disabled", async () => {
	const cwd = tmp("runner-isolation-");
	const journal = path.join(cwd, "wire.jsonl");
	await runnerTurn(
		{
			runner: "claude-code",
			cwd,
			text: "Report",
			signal: new AbortController().signal,
			onActivity: () => undefined,
			ctx: fakeCtx({ cwd }),
		},
		{
			launch: () => ({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url)), "report", journal],
			}),
			connect: connectAcp,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
		},
	);
	const created = fs
		.readFileSync(journal, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((row) => row.event === "new");
	expect(created.params.mcpServers).toEqual([]);
	expect(created.params._meta).toMatchObject({
		claudeCode: {
			options: { settingSources: [], strictMcpConfig: true, extraArgs: { "disable-slash-commands": null } },
		},
	});
});

it("keeps the subscription tool bridge while disabling ambient Claude skills", () => {
	expect(sessionMeta("Task instructions")).toMatchObject({
		claudeCode: {
			options: { tools: [], strictMcpConfig: true, settingSources: [], extraArgs: { "disable-slash-commands": null } },
		},
	});
});

const communication = {
	name: "octocode-team",
	url: "http://127.0.0.1:12345/mcp",
	headers: [{ name: "Authorization", value: "Bearer owned-private-token" }],
};
it.each(["claude-code", "codex", "opencode", "gemini"])("passes only the explicit bridge to %s ACP", async (runner) => {
	const cwd = tmp("runner-bridge-");
	const journal = path.join(cwd, "wire.jsonl");
	await runnerTurn(
		{
			runner,
			cwd,
			text: "Report",
			communication,
			signal: new AbortController().signal,
			onActivity: () => undefined,
			ctx: fakeCtx({ cwd }),
		},
		{
			launch: () => ({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url)), "report", journal],
			}),
			connect: connectAcp,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
		},
	);
	const created = fs
		.readFileSync(journal, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((row) => row.event === "new");
	expect(created.params.mcpServers).toEqual([{ ...communication, type: "http" }]);
});
it("refuses an unverified bridge before launching", async () => {
	const launch = vi.fn();
	const cwd = tmp("runner-refused-");
	await expect(
		runnerTurn(
			{
				runner: "custom",
				cwd,
				text: "Report",
				communication,
				signal: new AbortController().signal,
				onActivity: () => undefined,
				ctx: fakeCtx({ cwd }),
			},
			{ launch, connect: connectAcp, permission: () => async () => ({ outcome: { outcome: "cancelled" } }) },
		),
	).rejects.toThrow("no verified communication bridge");
	expect(launch).not.toHaveBeenCalled();
	expect(() => checkRunnerCommunication("claude-code", { ...communication, name: "wild*" })).toThrow("Invalid runner");
});
it.each([false, true])("keeps headless bridge credentials private and cleans up after failure=%s", async (fail) => {
	let config = "";
	const run = withCommunicationConfig(communication, async (args) => {
		config = args[1];
		expect(args.join(" ")).not.toContain("owned-private-token");
		expect(args.slice(2)).toEqual(["--allowedTools", "mcp__octocode-team__*"]);
		expect(fs.statSync(config).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers["octocode-team"].headers.Authorization).toBe(
			"Bearer owned-private-token",
		);
		if (fail) throw new Error("owned failure");
		return "done";
	});
	if (fail) await expect(run).rejects.toThrow("owned failure");
	else expect(await run).toBe("done");
	expect(fs.existsSync(path.dirname(config))).toBe(false);
});

it("restricts Gemini MCP to the explicit bridge without changing a no-bridge launch", () => {
	expect(runnerLaunchArgs("gemini", ["--acp"], "octocode-team")).toEqual([
		"--acp",
		"--allowed-mcp-server-names=octocode-team",
	]);
	expect(runnerLaunchArgs("gemini", ["--acp"])).toEqual(["--acp"]);
});
