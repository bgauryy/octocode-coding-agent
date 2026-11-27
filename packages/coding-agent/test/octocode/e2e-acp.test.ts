import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assetRootName } from "../../src/config.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";
import { acpClient, initialize } from "./e2e-acp-client.ts";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";

/**
 * An ACP client talking to Octocode as an editor would: a real process, newline-delimited JSON-RPC on stdin and stdout,
 * and a scripted model. It runs on the source CLI and, when one exists, on the built one, which reads its own copy of the
 * instructions: a build must not depend on text edited in `src/` after it.
 */
const BUILT = fileURLToPath(new URL("../../dist/bundle/cli.js", import.meta.url));

let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const agents = [
	{ name: "the source CLI", cli: undefined },
	...(fs.existsSync(BUILT) ? [{ name: "the built CLI", cli: BUILT }] : []),
];

describe.each(agents)("an ACP client and $name", ({ cli }) => {
	it("initializes, runs a tool and answers across two prompts, rejects a model change overlapping a prompt and allows it after cancellation, then exits when the client leaves", async () => {
		const box = sandbox(endpoint);
		const modelsFile = path.join(box.home, ".octocode", "octocodecode", "models.json");
		const models = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
			providers: { scripted: { models: Array<{ id: string; name: string }> } };
		};
		models.providers.scripted.models.push({
			...models.providers.scripted.models[0],
			id: "alternate",
			name: "alternate",
		});
		fs.writeFileSync(modelsFile, JSON.stringify(models));
		// ACP refuses `--trust`: a session's folder must already be trusted.
		seedTrust(box);
		const run = box.start(["--mode", "acp"], { stdin: "pipe", cli, trust: false });
		const acp = acpClient(run.process);
		const init = await acp.request<{ protocolVersion: number }>("initialize", initialize);
		expect(init.protocolVersion).toBe(1);
		const { sessionId } = await acp.request<{ sessionId: string }>("session/new", { cwd: box.project, mcpServers: [] });
		expect(sessionId).toEqual(expect.any(String));

		const first = await acp.prompt(
			sessionId,
			script([{ tool: "bash", args: { command: "echo acp-tool" } }, { text: "first reply" }]),
		);
		expect(first.stopReason).toBe("end_turn");
		expect(acp.updates.some(({ update }) => update.sessionUpdate === "tool_call")).toBe(true);
		expect(acp.said()).toContain("first reply");
		// The tool really ran, and its result reached the model.
		expect(endpoint.requests.at(-1)?.toolResults.join("\n")).toContain("acp-tool");
		// The agent's instructions rendered: an error there would have replaced them.
		expect(endpoint.requests.at(-1)?.system).toContain("<work>");

		expect((await acp.prompt(sessionId, script([{ text: "second reply" }]))).stopReason).toBe("end_turn");
		expect(acp.said()).toContain("second reply");

		const changeParams = { sessionId, configId: "model", value: "scripted/alternate" };
		// Send both without awaiting: the model setter must recheck ownership after its async work.
		const hanging = script([{ hang: true }]);
		run.process.stdin?.cork();
		const change = acp.raw("session/set_config_option", changeParams);
		const turn = acp.prompt(sessionId, hanging);
		run.process.stdin?.uncork();
		await until(
			() => endpoint.requests.some((request) => request.lastUserText.includes(hanging)),
			"the overlapping prompt",
		);
		const response = await change;
		const requestedModel = endpoint.requests.at(-1)?.model;
		acp.notify("session/cancel", { sessionId });
		expect((await turn).stopReason).toBe("cancelled");
		expect(response.error).toMatchObject({ message: expect.stringMatching(/busy/i) });
		expect(requestedModel).toBe("model");
		await acp.request("session/set_config_option", changeParams);
		expect((await acp.prompt(sessionId, script([{ text: "alternate reply" }]))).stopReason).toBe("end_turn");
		expect(endpoint.requests.at(-1)?.model).toBe("alternate");
		expect(acp.said()).toContain("alternate reply");

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expect(box.survivors()).toEqual([]);
	});
});

describe("where a running CLI reads its assets", () => {
	const root = path.join(path.sep, "work", "package");

	it("uses dist/ for built code, even in a checkout that has src/", () => {
		expect(assetRootName(root, path.join(root, "dist", "bundle", "octocode.js"), true)).toBe("dist");
	});

	it("uses src/ when running from source, and dist/ in a package without src/", () => {
		expect(assetRootName(root, path.join(root, "src", "config.ts"), true)).toBe("src");
		expect(assetRootName(root, path.join(root, "dist", "bundle", "octocode.js"), false)).toBe("dist");
	});
});
