import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ERR, RpcError, WAIT_MS } from "../../src/octocode/api/protocol.ts";
import { apiDir, ensurePrivateDir, socketPath, writeRecord } from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";

const cli = fileURLToPath(new URL("../../src/octocode/api/cli.ts", import.meta.url));
const resolver = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
	for (const child of children) child.kill("SIGTERM");
	children.clear();
	await Promise.all(cleanup.splice(0).map((close) => close()));
});

function run(home: string, args: string[]) {
	let output = "";
	let errors = "";
	const done = new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
		const child = execFile(
			process.execPath,
			["--import", resolver, cli, ...args],
			{ env: { ...process.env, OCTOCODE_HOME: home }, encoding: "utf8", timeout: 15_000 },
			(error, stdout, stderr) => {
				children.delete(child);
				resolve({ code: error?.code ?? 0, stdout, stderr });
			},
		);
		children.add(child);
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			errors += chunk;
		});
	});
	return { done, stdout: () => output, stderr: () => errors };
}

async function fixture(dispatch: ConstructorParameters<typeof ApiServer>[0], transport: "socket" | "http" = "socket") {
	const home = mkdtempSync(join(tmpdir(), "api-cli-test-"));
	const directory = apiDir({ OCTOCODE_HOME: home });
	ensurePrivateDir(directory);
	const token = "private-cli-fixture-authentication";
	const log = new EventLog();
	const server = new ApiServer(dispatch, log, token);
	cleanup.push(async () => {
		await server.close();
		rmSync(home, { recursive: true, force: true });
	});
	if (transport === "http") await server.listenHttp(0);
	else await server.listenUnix(socketPath(directory, "fixture"));
	writeRecord(directory, {
		id: "fixture",
		pid: process.pid,
		cwd: home,
		protocol: 1,
		startedAt: Date.now(),
		...(transport === "socket" ? { socket: server.socketFile } : { http: { url: server.httpUrl!, token } }),
	});
	return { home, log, server, token };
}

describe.skipIf(process.platform === "win32")("API CLI subprocess", () => {
	it("sends session guards, idempotency and timeout options while preserving ordinary success output", async () => {
		const dispatch = vi.fn(async (_method: string, params: Record<string, unknown>) =>
			params.wait ? { id: "x1", text: "reply from the agent" } : { id: "x1", queued: "turn" },
		);
		const { home } = await fixture(dispatch);
		const sent = await run(home, [
			"send",
			"--to",
			"fixture",
			"--from",
			"codex",
			"--mode",
			"followUp",
			"--key",
			"k1",
			"--session",
			"s1",
			"--timeout",
			String(WAIT_MS.min),
			"--require-idle",
			"--",
			"--please",
			"inspect",
		]).done;
		expect(sent).toEqual({ code: 0, stdout: '{"id":"x1","queued":"turn"}\n', stderr: "" });
		expect(dispatch).toHaveBeenCalledWith(
			"message.send",
			{
				text: "--please inspect",
				caller: { pid: expect.any(Number), cwd: process.cwd() },
				from: "codex",
				mode: "followUp",
				key: "k1",
				expectedSessionId: "s1",
				timeoutMs: WAIT_MS.min,
				requireIdle: true,
			},
			expect.anything(),
		);
		const waited = await run(home, ["send", "--wait", "hello"]).done;
		expect(waited).toEqual({ code: 0, stdout: "reply from the agent\n", stderr: "" });
	});

	it.each([
		["error", { id: "x1", text: "", stopReason: "error", errorMessage: "401: Invalid API key" }],
		["aborted", { id: "x1", text: "partial", stopReason: "aborted" }],
		["length", { id: "x1", text: "cut", stopReason: "length" }],
	])("--wait exits 1 and puts the result on stderr when a run ends in %s", async (_name, result) => {
		const { home } = await fixture(async () => result);
		const waited = await run(home, ["send", "--wait", "hello"]).done;
		expect(waited.code).toBe(1);
		expect(waited.stdout).toBe("");
		expect(JSON.parse(waited.stderr)).toEqual(result);
	});

	it("--wait treats a finished run as a success, and without --wait a receipt is never judged", async () => {
		const { home } = await fixture(async (_method, params) =>
			params.wait ? { id: "x1", text: "fine", stopReason: "stop" } : { id: "x1", queued: "turn", stopReason: "error" },
		);
		expect(await run(home, ["send", "--wait", "hello"]).done).toEqual({ code: 0, stdout: "fine\n", stderr: "" });
		expect((await run(home, ["send", "hello"]).done).code).toBe(0);
	});

	it("rejects misspelled, misplaced and invalid numeric flags without contacting an agent", async () => {
		const dispatch = vi.fn(async () => ({}));
		const { home } = await fixture(dispatch);
		const cases = [
			["send", "--sesion", "s1", "hello"],
			["status", "--wait"],
			["send", "--timeout", "999", "hello"],
			["send", "--timeout", String(WAIT_MS.max + 1), "hello"],
			["send", "--timeout", "1.5", "hello"],
			["watch", "--since", "-1"],
			["watch", "--since", "9007199254740992"],
			["list", "ignored"],
		];
		for (const result of await Promise.all(cases.map((args) => run(home, args).done))) {
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBeTruthy();
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("keeps accepted receipt metadata after the server wait expires and redacts the HTTP credential", async () => {
		const { home, token } = await fixture(async () => {
			await new Promise((resolve) => setTimeout(resolve, WAIT_MS.min + 50));
			throw new RpcError(ERR.timeout, `Wait elapsed: private-cli-fixture-authentication`, {
				execution: "accepted",
				id: "x9",
				queued: "turn",
				token: "private-cli-fixture-authentication",
			});
		}, "http");
		const result = await run(home, ["send", "--wait", "--timeout", String(WAIT_MS.min), "--key", "receipt-9", "work"])
			.done;
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(token);
		expect(JSON.parse(result.stderr)).toEqual({
			error: "Wait elapsed: [redacted]",
			code: ERR.timeout,
			data: { execution: "accepted", id: "x9", queued: "turn", token: "[redacted]" },
		});
	});

	it("replays events after --since and keeps the requested event and top-level filters", async () => {
		const received: Record<string, unknown>[] = [];
		const { home, log, server } = await fixture(async (method, params, connection) => {
			expect(method).toBe("events.subscribe");
			received.push(params);
			return connection.subscribe!({ since: params.since as number, types: params.types as string[] });
		});
		log.publish("tool.end", { id: "old" });
		log.publish("tool.end", { id: "nested", parentId: "parent" });
		const wanted = log.publish("tool.end", { id: "wanted" });
		log.publish("message", { text: "excluded" });
		const watching = run(home, ["watch", "--since", "1", "--types", "tool.end", "--top-level"]);
		await vi.waitFor(() => expect(watching.stdout()).toContain('"wanted"'));
		await server.close();
		const result = await watching.done;
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(
			result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([wanted]);
		expect(received).toEqual([{ since: 1, types: ["tool.end"] }]);
	});

	it("warns about lost replay history on stderr without adding non-events to stdout", async () => {
		const { home, log, server } = await fixture(async (_method, params, connection) =>
			connection.subscribe!({ since: params.since as number, types: params.types as string[] }),
		);
		for (let index = 0; index < 501; index++) log.publish("tool.end", { index });
		const watching = run(home, ["watch", "--since", "0", "--types", "message"]);
		await vi.waitFor(() => expect(watching.stderr()).toContain("Event replay has a gap"));
		await server.close();
		const result = await watching.done;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toMatchObject({ since: 0, seq: 501 });
	});
});
