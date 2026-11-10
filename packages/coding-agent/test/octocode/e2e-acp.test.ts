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
} from "./e2e-real-process-harness.ts";
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
	await endpoint.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

interface Message {
	id?: number;
	method?: string;
	params?: Record<string, never> & {
		update?: { sessionUpdate?: string; content?: { text?: string } };
		options?: Array<{ optionId: string; kind: string }>;
	};
	result?: Record<string, unknown>;
	error?: { message: string };
}

/** A minimal ACP client on a process's pipes: requests by id, and it allows every permission the agent asks about. */
function client(run: ReturnType<ReturnType<typeof sandbox>["start"]>) {
	const updates: NonNullable<Message["params"]>["update"][] = [];
	const pending = new Map<number, (message: Message) => void>();
	let buffer = "";
	let next = 1;
	const send = (message: Record<string, unknown>) =>
		run.process.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	run.process.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const message = JSON.parse(buffer.slice(0, end)) as Message;
			buffer = buffer.slice(end + 1);
			if (message.method === "session/update") updates.push(message.params?.update);
			else if (message.method === "session/request_permission") {
				const allow = message.params?.options?.find((option) => option.kind.startsWith("allow"));
				send({ id: message.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
			} else if (message.id !== undefined) pending.get(message.id)?.(message);
		}
	});
	const request = (method: string, params: Record<string, unknown>) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = next++;
			pending.set(id, (message) =>
				message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result ?? {}),
			);
			send({ id, method, params });
		});
	return { request, updates };
}

const agents = [
	{ name: "the source CLI", cli: undefined },
	...(fs.existsSync(BUILT) ? [{ name: "the built CLI", cli: BUILT }] : []),
];

describe.each(agents)("an ACP client and $name", ({ cli }) => {
	it("initializes, opens a session, runs a tool and answers across two prompts, then exits when the client leaves", async () => {
		const box = sandbox(endpoint);
		// ACP refuses `--trust`: a session's folder must already be trusted.
		seedTrust(box);
		const run = box.start(["--mode", "acp"], { stdin: "pipe", cli, trust: false });
		const { request, updates } = client(run);

		const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		expect(init.protocolVersion).toBe(1);
		const { sessionId } = (await request("session/new", { cwd: box.project, mcpServers: [] })) as { sessionId: string };
		expect(sessionId).toEqual(expect.any(String));

		const first = await request("session/prompt", {
			sessionId,
			prompt: [
				{ type: "text", text: script([{ tool: "bash", args: { command: "echo acp-tool" } }, { text: "first reply" }]) },
			],
		});
		expect(first.stopReason).toBe("end_turn");
		expect(updates.some((update) => update?.sessionUpdate === "tool_call")).toBe(true);
		const said = () =>
			updates
				.filter((update) => update?.sessionUpdate === "agent_message_chunk")
				.map((update) => update?.content?.text ?? "")
				.join("");
		expect(said()).toContain("first reply");
		// The tool really ran, and its result reached the model.
		expect(endpoint.requests.at(-1)?.toolResults.join("\n")).toContain("acp-tool");
		// The agent's instructions rendered: an error there would have replaced them.
		expect(endpoint.requests.at(-1)?.system).toContain("<work>");

		const second = await request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: script([{ text: "second reply" }]) }],
		});
		expect(second.stopReason).toBe("end_turn");
		expect(said()).toContain("second reply");

		run.process.stdin?.end();
		const { code } = await run.exited;
		expect(code).toBe(0);
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
