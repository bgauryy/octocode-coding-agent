import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, describe, expect, it } from "vitest";
import { foregroundOperations } from "../../src/octocode/files/bash-run.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE, DENY, sessionOption } from "../../src/octocode/permission/ask/text.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { sandboxPrompts } from "../../src/octocode/permission/sandbox/prompts.ts";
import { SrtCommandSandbox } from "../../src/octocode/permission/sandbox/srt.ts";
import { sandboxDenials, setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { getShellEnv, resolveBashShell, spawnShell } from "../../src/utils/shell.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { mainEnv } from "./sandbox-helpers.ts";

/**
 * The sandbox's network (S4) through the real proxy and real permission checks, offline: the server is this machine's,
 * and `localhost` reaches the proxy as a name (`NO_PROXY=` sends it there) that the injected lookup calls public.
 */
const macOnly = process.platform === "darwin" ? describe : describe.skip;
const servers: http.Server[] = [];
const outsideDirs: string[] = [];

afterEach(() => {
	setCommandSandbox(undefined);
	for (const server of servers.splice(0)) server.close();
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(host = "127.0.0.1"): Promise<number> {
	const server = http.createServer((_request, response) => response.end("hello"));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	return (server.address() as { port: number }).port;
}

/** A session in `mode` whose dialogs answer `selects` in order, with its sandbox installed; `asked` collects dialog titles. */
function session(mode: PermissionMode, selects: string[], env: NodeJS.ProcessEnv = mainEnv()) {
	const cwd = tmp();
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects } });
	permission.start(ctx);
	const asked: string[] = [];
	const select = ctx.ui.select;
	ctx.ui.select = async (title: string, choices: string[]) => {
		asked.push(title);
		return select(title, choices);
	};
	const prompts = sandboxPrompts(permission, ctx, {
		env,
		lookup: async () => [{ address: "93.184.215.14" }],
	});
	setCommandSandbox(
		new SrtCommandSandbox((dir) => sandboxPolicy(dir, { setting: "on", mode: permission.mode, env }), { prompts }),
	);
	return { cwd, asked };
}

async function run(command: string, cwd: string) {
	const child = await spawnShell(resolveBashShell(), command, { cwd, env: getShellEnv() });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk));
	const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
	return { code, output, child };
}

/** `curl` through the proxy to this machine's server by name. */
const viaProxy = (port: number) => `NO_PROXY= no_proxy= curl -sf -m 10 http://localhost:${port}/`;
const grantLabel = sessionOption("shell connections to localhost");

macOnly("the command sandbox's network (sandbox.mode: on)", () => {
	it("asks for a new host; allowed for the session, the next command connects without asking", async () => {
		const port = await serve();
		const { cwd, asked } = session("workspace", [grantLabel]);
		const first = await run(viaProxy(port), cwd);
		expect(first.output).toBe("hello");
		const second = await run(viaProxy(port), cwd);
		expect(second.output).toBe("hello");
		expect(asked.map((title) => title.split("\n")[0])).toEqual(["Let a shell command connect to this host?"]);
	});

	it("fails a denied host and names it in the command's denials", async () => {
		const port = await serve();
		const { cwd, asked } = session("manual", [DENY]);
		const denied = await run(viaProxy(port), cwd);
		expect(denied.code).not.toBe(0);
		expect(denied.output).not.toContain("hello");
		expect(asked).toHaveLength(1);
		expect(await sandboxDenials(denied.child, { suspected: false })).toMatch(
			new RegExp(`deny network-outbound localhost:${port}`),
		);
	});

	it("allowed once: the running command reconnects unasked, the next command asks again", async () => {
		const port = await serve();
		const { cwd, asked } = session("workspace", [ALLOW_ONCE, ALLOW_ONCE]);
		const twice = await run(`${viaProxy(port)} && ${viaProxy(port)}`, cwd);
		expect(twice.output).toBe("hellohello");
		expect(asked).toHaveLength(1);
		expect((await run(viaProxy(port), cwd)).output).toBe("hello");
		expect(asked).toHaveLength(2);
	});

	it("allows every host unasked in full mode", async () => {
		const port = await serve();
		const { cwd, asked } = session("full", []);
		expect((await run(viaProxy(port), cwd)).output).toBe("hello");
		expect(asked).toEqual([]);
	});

	it("gives a read-only subagent's commands no network, without asking", async () => {
		const port = await serve();
		const { cwd, asked } = session("full", [], mainEnv({ [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" }));
		const result = await run(viaProxy(port), cwd);
		expect(result.code).not.toBe(0);
		expect(asked).toEqual([]);
	});

	it("keeps loopback reachable directly, as a test server needs", async () => {
		const port = await serve();
		const { cwd, asked } = session("manual", []);
		expect((await run(`curl -sf -m 10 http://127.0.0.1:${port}/`, cwd)).output).toBe("hello");
		expect(asked).toEqual([]);
	});

	it("fails a connection that skips the proxy at once, even in full mode", async () => {
		const { cwd } = session("full", []);
		// 192.0.2.1 is a documentation address (TEST-NET-1): Seatbelt refuses the connect before any packet leaves, so curl
		// fails with 7 (could not connect) instead of 28 (timed out), which an unroutable address gives without the sandbox.
		const direct = await run("curl --noproxy '*' -s -m 8 http://192.0.2.1:9/; echo rc=$?", cwd);
		expect(direct.output.trim()).toBe("rc=7");
	});

	it("names a refused write's path in a failed foreground command's output", async () => {
		const { cwd } = session("workspace", []);
		const outside = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-sandbox-test-"));
		outsideDirs.push(outside);
		const target = path.join(outside, "x.txt");
		let output = "";
		const result = await foregroundOperations({}, () => undefined).exec(`echo 1 > '${target}'`, cwd, {
			onData: (chunk) => (output += chunk),
			env: getShellEnv(),
		});
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("The sandbox refused:");
		expect(output).toContain(`file-write-create ${fs.realpathSync(outside)}/x.txt`);
		expect(output).toContain("sandbox: false (asks the user)");
	});
});
