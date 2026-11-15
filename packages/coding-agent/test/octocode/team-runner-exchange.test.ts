import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { runnerTurn } from "../../src/octocode/external/runner-session.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const peer = fileURLToPath(new URL("./fixtures/team-runner-acp.mjs", import.meta.url));
const sleep = () => new Promise((resolve) => setTimeout(resolve, 10));
const read = (file: string) =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((row) => JSON.parse(row))
		: [];
async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Owned runner did not reach its barrier");
		await sleep();
	}
}

it("exchanges and acknowledges mail across a real CLI process and internal team through a partially refused task batch", async () => {
	const cwd = tmp("runner-exchange-");
	fs.mkdirSync(path.join(cwd, ".git"));
	const env = { OCTOCODE_AGENT_DB: path.join(cwd, "team.sqlite") };
	const f = fakeHost(),
		team = new Team(f.api, env),
		ctx = fakeCtx({ cwd, hasUI: true });
	team.start(ctx);
	team.join();
	const siblingHost = fakeHost();
	const sibling = new Team(siblingHost.api, {
		...env,
		OCTOCODE_AGENT_ID: "internal-child",
		OCTOCODE_PARENT_ID: team.id,
	});
	sibling.start(fakeCtx({ cwd }));
	const journal = path.join(cwd, "cli.jsonl");
	const modes = agentModes();
	const controls = registerAgentTool(f.api, {
		profiles: () => new Map(),
		team,
		permission: fakePermission(),
		registerTool: modes.collect,
		runners: {
			ids: ["claude-code"],
			communication: ["claude-code"],
			turn: (input) =>
				runnerTurn(input, {
					launch: () => ({ command: process.execPath, args: [peer, journal], billing: "plan" }),
					connect: connectAcp,
					permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
				}),
		},
	});
	modes.register(f.api);
	const store = TeamStore.open(cwd, env.OCTOCODE_AGENT_DB, env);
	try {
		const receipt = await f.tools.get("agent").execute(
			"mixed",
			{
				type: "task",
				reason: "transport contract",
				background: true,
				tasks: [
					{
						runner: "claude-code",
						goal: "Exchange scoped mail",
						task: "Exchange mail through the explicit team server",
					},
					{ runner: "missing", goal: "Refuse unavailable route", task: "Must not launch" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(receipt.isError).toBe(true);
		expect(receipt.details.batch.map((entry: { ok: boolean }) => entry.ok)).toEqual([true, false]);
		const id = receipt.details.batch[0].details.id;
		await until(() => read(journal).some((row) => row.event === "ready"));
		expect(read(journal).find((row) => row.event === "servers").names).toEqual(["octocode-team"]);
		expect(read(journal).find((row) => row.event === "ready").tools).toEqual(["team"]);
		const parentMail = await team.send(id, "PARENT_QUESTION", { replyRequired: true });
		const siblingMail = await sibling.send(id, "INTERNAL_QUESTION", { replyRequired: true });
		expect(parentMail).toMatchObject({ delivery: { [id]: "pull" } });
		expect(siblingMail).toMatchObject({ delivery: { [id]: "pull" } });
		fs.writeFileSync(`${journal}.continue`, "");
		await until(() => read(journal).some((row) => row.event === "replied"));
		expect(read(journal).find((row) => row.event === "spoof").refused).toBe(true);
		expect(store.pending(id)).toEqual([]);
		expect(
			store.pending(team.id!).some((message) => message.from === id && message.text.startsWith("EXTERNAL_REPLY_")),
		).toBe(true);
		expect(
			store.pending(sibling.id!).some((message) => message.from === id && message.text.startsWith("EXTERNAL_REPLY_")),
		).toBe(true);
		fs.writeFileSync(`${journal}.finish`, "");
		await controls.settle();
		expect(store.names()).not.toContain(id);
		expect(() => process.kill(read(journal)[0].pid, 0)).toThrow();
	} finally {
		fs.writeFileSync(`${journal}.continue`, "");
		fs.writeFileSync(`${journal}.finish`, "");
		await controls.stopAll();
		sibling.stop();
		team.stop();
		store.close();
	}
});
