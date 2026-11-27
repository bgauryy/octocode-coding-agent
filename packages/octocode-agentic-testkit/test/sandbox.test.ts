import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess, type ProcessOptions } from "../src/process.ts";
import { sandboxAvailable, type SandboxOptions } from "../src/sandbox.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run's layout as the adapters make it: a temp root holding HOME and TMPDIR, a workspace, and a sibling outside. */
function layout() {
	const base = mkdtempSync(join(tmpdir(), "testkit-sbx-"));
	dirs.push(base);
	const root = join(base, "root");
	const workspace = join(base, "workspace");
	const outside = join(base, "outside");
	for (const d of [join(root, "home"), join(root, "tmp"), workspace, outside]) mkdirSync(d, { recursive: true });
	return { base, root, home: join(root, "home"), tmp: join(root, "tmp"), workspace, outside };
}

const node = process.execPath;

function opts(
	l: ReturnType<typeof layout>,
	sandbox: SandboxOptions = {},
	env: Record<string, string> = {},
): ProcessOptions {
	return {
		env: { PATH: process.env.PATH ?? "", HOME: l.home, TMPDIR: l.tmp, ...env },
		cwd: l.workspace,
		timeoutMs: 20_000,
		home: l.home,
		sandbox: { root: l.root, ...sandbox },
	};
}

const js = (code: string): string[] => ["-e", code];
const fetchScript = (url: string): string[] =>
	js(
		`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(8000)}).then(async r=>console.log("status "+r.status+" "+(await r.text()).slice(0,20)),e=>{console.error("blocked "+(e.cause?.code??e.message));process.exit(3)})`,
	);

it.runIf(process.platform === "darwin")("is available on macOS", () => {
	expect(sandboxAvailable()).toBeUndefined();
});

const unavailable = sandboxAvailable();

describe.skipIf(unavailable !== undefined)(`process sandbox${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
	it("lets the process write inside the workspace, the root and its TMPDIR", async () => {
		const l = layout();
		const r = await runProcess(
			node,
			js(
				`const fs=require("fs"),os=require("os");fs.writeFileSync("in.txt","ok");fs.writeFileSync(process.env.HOME+"/h.txt","ok");fs.writeFileSync(os.tmpdir()+"/t.txt","ok");console.log(os.tmpdir())`,
			),
			opts(l),
		);
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe(l.tmp);
		expect(readFileSync(join(l.workspace, "in.txt"), "utf8")).toBe("ok");
		expect(existsSync(join(l.home, "h.txt"))).toBe(true);
		expect(existsSync(join(l.tmp, "t.txt"))).toBe(true);
	});

	it("refuses a write outside the root and workspace, and the file does not exist", async () => {
		const l = layout();
		const targets = [
			join(l.outside, "x.txt"),
			join(l.base, "sibling.txt"),
			join(tmpdir(), `testkit-sbx-${process.pid}.txt`),
		];
		const r = await runProcess(
			node,
			js(
				`let n=0;for(const p of ${JSON.stringify(targets)}){try{require("fs").writeFileSync(p,"x")}catch(e){n++;console.error(e.code)}}process.exit(n===${targets.length}?0:1)`,
			),
			opts(l),
		);
		expect(r.stderr.trim().split("\n")).toEqual(targets.map(() => "EPERM"));
		expect(r.exitCode).toBe(0);
		for (const t of targets) expect(existsSync(t)).toBe(false);
	});

	it("`writable` replaces the default: the root is closed when only the workspace is listed", async () => {
		const l = layout();
		const r = await runProcess(
			node,
			js(`require("fs").writeFileSync("in.txt","ok");require("fs").writeFileSync(process.env.HOME+"/h.txt","x")`),
			opts(l, { writable: [l.workspace] }),
		);
		expect(r.exitCode).not.toBe(0);
		expect(r.stderr).toMatch(/EPERM/);
		expect(existsSync(join(l.workspace, "in.txt"))).toBe(true);
		expect(existsSync(join(l.home, "h.txt"))).toBe(false);
	});

	it("refuses to read a denied path; `readable` re-opens a file inside it", async () => {
		const l = layout();
		writeFileSync(join(l.outside, "secret.txt"), "top secret");
		writeFileSync(join(l.outside, "shared.txt"), "shared");
		const read = (p: string) => js(`process.stdout.write(require("fs").readFileSync(${JSON.stringify(p)},"utf8"))`);
		const denied = await runProcess(node, read(join(l.outside, "secret.txt")), opts(l, { denyRead: [l.outside] }));
		expect(denied.exitCode).not.toBe(0);
		expect(denied.stderr).toMatch(/EPERM/);
		expect(denied.stdout).not.toContain("top secret");
		const reopened = await runProcess(
			node,
			read(join(l.outside, "shared.txt")),
			opts(l, { denyRead: [l.outside], readable: [join(l.outside, "shared.txt")] }),
		);
		expect(reopened).toMatchObject({ exitCode: 0, stdout: "shared" });
	});

	it("reaches a loopback server the test started (the gateway's case)", async () => {
		const l = layout();
		const server = createServer((_q, s) => s.end("pong"));
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const { port } = server.address() as AddressInfo;
			const r = await runProcess(node, fetchScript(`http://127.0.0.1:${port}/`), opts(l));
			expect(r.stderr).toBe("");
			expect(r.stdout.trim()).toBe("status 200 pong");
		} finally {
			await new Promise((done) => server.close(done));
		}
	});

	it("blocks an external host directly and through the proxy; `network.allow` lets it through", async (ctx) => {
		const probe = await fetch("https://example.com", { signal: AbortSignal.timeout(8000) }).then(
			(r) => `status ${r.status}`,
			(e: unknown) => (e as { cause?: { code?: string } }).cause?.code ?? String(e),
		);
		if (!probe.startsWith("status ")) ctx.skip(`no network on this machine: https://example.com answered ${probe}`);
		const l = layout();
		const direct = await runProcess(node, fetchScript("https://example.com"), opts(l));
		expect(direct.exitCode).toBe(3);
		expect(direct.stderr).toMatch(/^blocked /);
		const proxied = await runProcess(
			node,
			fetchScript("https://example.com"),
			opts(l, {}, { NODE_USE_ENV_PROXY: "1" }),
		);
		expect(proxied.exitCode).toBe(3);
		expect(proxied.stdout).toBe("");
		const allowed = await runProcess(
			node,
			fetchScript("https://example.com"),
			opts(l, { network: { allow: ["example.com"] } }, { NODE_USE_ENV_PROXY: "1" }),
		);
		expect(allowed.stderr).toBe("");
		expect(allowed.stdout).toMatch(/^status 200 /);
	});

	it("rejects a command that is not on PATH, as an unsandboxed spawn does", async () => {
		await expect(runProcess("testkit-no-such-command", [], opts(layout()))).rejects.toThrow(/ENOENT/);
	});

	it("rejects an invalid host in the allow list instead of running", async () => {
		const l = layout();
		const marker = join(l.workspace, "ran.txt");
		await expect(
			runProcess(
				node,
				js(`require("fs").writeFileSync(${JSON.stringify(marker)},"x")`),
				opts(l, { network: { allow: ["http://bad/"] } }),
			),
		).rejects.toThrow();
		expect(existsSync(marker)).toBe(false);
	});

	it("kills the sandboxed process on timeout, the program inside the wrapper included", async () => {
		const l = layout();
		const marker = join(l.workspace, "pid.txt");
		const r = await runProcess(
			node,
			js(`require("fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`),
			{ ...opts(l), timeoutMs: 1500 },
		);
		expect(r.timedOut).toBe(true);
		const pid = Number(readFileSync(marker, "utf8"));
		await new Promise((done) => setTimeout(done, 200));
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
