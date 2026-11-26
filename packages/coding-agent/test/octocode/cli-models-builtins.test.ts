import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { externalRoutes } from "../../src/octocode/cli-models/register.ts";
import { resetGateRecords } from "../../src/octocode/guard/registry.ts";
import { ask, bin, runner, setup } from "./cli-models-helpers.ts";
import { tmp } from "./helpers.ts";

const PEER = fileURLToPath(new URL("./fixtures/claude-code-peer.mjs", import.meta.url));

/** Each built-in runner: its provider id and the program its ACP server starts. */
const BUILTINS = [
	["codex-cli", "codex-acp"],
	["opencode-cli", "opencode"],
	["gemini-cli", "gemini"],
	["agy-cli", "agy"],
] as const;
const STATES = ["codex", "opencode", "gemini", "agy"].map(runner);

afterEach(() => resetGateRecords());

const routesWith = (path_: string) => {
	const { agentDir, cwd } = setup({});
	return externalRoutes({ states: STATES, cwd, agentDir, env: { PATH: path_ }, projectTrusted: false }).routes;
};

describe("the built-in CLI runners /model lists", () => {
	it("lists codex, gemini, opencode and agy in order when each binary is on PATH", () => {
		const routes = routesWith(bin(Object.fromEntries(BUILTINS.map(([, command]) => [command, "exit 0"]))));
		expect(routes.map((route) => [route.provider, route.source, route.plan.disabled])).toEqual(
			BUILTINS.map(([provider]) => [provider, "built-in", undefined]),
		);
	});

	it("lists each as unavailable when its binary is missing", () => {
		const routes = routesWith(bin({}));
		expect(routes.map((route) => route.provider)).toEqual(BUILTINS.map(([provider]) => provider));
		BUILTINS.forEach(([, command], index) =>
			expect(routes[index].plan.disabled).toContain(`${command} was not found on PATH`),
		);
	});

	it("lists only the binary that is missing as unavailable", () => {
		const routes = routesWith(bin({ codex: "exit 0", gemini: "exit 0", agy: "exit 0" }));
		expect(routes.map((route) => [route.provider, route.plan.disabled === undefined])).toEqual([
			["codex-cli", false],
			["opencode-cli", false],
			["gemini-cli", true],
			["agy-cli", true],
		]);
	});
});

describe("a turn on a built-in CLI", () => {
	/** A fake `codex-acp` that runs the ACP peer fixture with `script`; returns its PATH folder and journal. */
	const fakeCodex = (prompts: object) => {
		const journal = path.join(tmp("octocode-cli-builtin-"), "journal.jsonl");
		const script = JSON.stringify({ prompts });
		const dir = bin({ "codex-acp": `exec '${process.execPath}' '${PEER}' '${journal}' '${script}'` });
		const { agentDir, cwd } = setup({});
		const [route] = externalRoutes({
			states: [runner("codex")],
			cwd,
			agentDir,
			env: { PATH: `${dir}:/usr/bin:/bin` },
			projectTrusted: false,
		}).routes;
		return { route, journal };
	};

	it("answers a turn through the runner's ACP server", async () => {
		const { route } = fakeCodex([[{ say: "Hello from codex." }]]);
		expect(route.provider).toBe("codex-cli");
		const reply = await ask(route, "Say hello");
		expect(reply).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hello from codex." }] });
	});

	it("cancelling a waiting turn ends the reply as aborted", async () => {
		const { route, journal } = fakeCodex([[{ say: "Working" }, { wait: true }]]);
		const controller = new AbortController();
		const pending = ask(route, "Start", controller.signal);
		const prompted = () => fs.existsSync(journal) && fs.readFileSync(journal, "utf8").includes('"event":"prompt"');
		for (let tries = 0; tries < 250 && !prompted(); tries++) await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		expect((await pending).stopReason).toBe("aborted");
	});
});
