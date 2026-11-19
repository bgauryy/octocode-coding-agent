import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { octocodeAgentAdapter } from "../src/adapters/octocode-agent/index.ts";
import { claudeCodeAdapter } from "../src/adapters/claude-code/index.ts";
import { codexAdapter } from "../src/adapters/codex/index.ts";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import { runProcess, writeFiles } from "../src/process.ts";
import { script } from "../src/gateway.ts";
import { Trace } from "../src/trace.ts";
import { gateway } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "testkit-proc-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const node = process.execPath;
const opts = (cwd: string, timeoutMs = 10_000) => ({
	env: { PATH: process.env.PATH ?? "" },
	cwd,
	timeoutMs,
	home: cwd,
});

describe("runProcess", () => {
	it("captures output and parses JSON lines only", async () => {
		const cwd = tmp();
		const r = await runProcess(
			node,
			["-e", 'console.log(JSON.stringify({a:1}));console.log("plain");console.error("err");console.log("[1]");'],
			opts(cwd),
		);
		expect(r).toMatchObject({ exitCode: 0, timedOut: false, stderr: "err\n", home: cwd, workspace: cwd });
		expect(r.events).toEqual([{ a: 1 }, [1]]);
	});

	it("kills the process group on timeout, children included", async () => {
		const cwd = tmp();
		const marker = join(cwd, "child.pid");
		const code = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
		const r = await runProcess(node, ["-e", code], opts(cwd, 600));
		expect(r.timedOut).toBe(true);
		const pid = Number(readFileSync(marker, "utf8"));
		await new Promise((res) => setTimeout(res, 200));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("rejects when the command cannot start", async () => {
		await expect(runProcess("testkit-no-such-command", [], opts(tmp()))).rejects.toThrow();
	});

	it("rejects a sandboxed run when the sandbox cannot start, and never runs the command unsandboxed", async () => {
		const cwd = tmp();
		const marker = join(cwd, "ran.txt");
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...platform, value: "linux" });
		try {
			await expect(
				runProcess(node, ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], {
					...opts(cwd),
					sandbox: {},
				}),
			).rejects.toThrow(/the process sandbox cannot start: .*macOS only \(this is linux\)/);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("`sandbox: false` runs on the host as before", async () => {
		const r = await runProcess(node, ["-e", "console.log(process.env.SANDBOX_RUNTIME ?? 'host')"], {
			...opts(tmp()),
			sandbox: false,
		});
		expect(r.stdout.trim()).toBe("host");
	});
});

describe("writeFiles", () => {
	it("creates parent directories", () => {
		const d = tmp();
		writeFiles(d, { "a/b/c.txt": "x", "top.txt": "y" });
		expect(readFileSync(join(d, "a/b/c.txt"), "utf8")).toBe("x");
		expect(existsSync(join(d, "top.txt"))).toBe(true);
	});
});

/** A stand-in bundle that reports its argv, key variable and files, and leaks the key on stderr. */
function fakeBundle(): string {
	const dir = tmp();
	const file = join(dir, "bundle.js");
	writeFileSync(
		file,
		`const fs=require("fs"),path=require("path");const h=process.env.OCTOCODE_HOME;
const read=(p)=>{try{return fs.readFileSync(path.join(h,p),"utf8")}catch{return null}};
console.log(JSON.stringify({argv:process.argv.slice(2),key:process.env.TESTKIT_PROVIDER_KEY??null,extra:process.env.EXTRA??null,
models:read("models.json"),mcp:read("mcp.json"),settings:read("settings.json"),skill:read("skills/s1/SKILL.md"),
file:fs.existsSync("w/f.txt")?fs.readFileSync("w/f.txt","utf8"):null}));
console.error("leak "+process.env.TESTKIT_PROVIDER_KEY);`,
	);
	return file;
}

describe("octocode-agent adapter options", () => {
	it("writes skills, settings, provider, mcp config; passes prompts, thinking and the key privately", async () => {
		const gw = await gateway({ responder: script([{ text: "x" }]) });
		const session = await octocodeAgentAdapter({
			bundle: fakeBundle(),
			skills: { s1: "# skill" },
			settings: { theme: "x" },
			provider: { id: "prov", api: "anthropic-messages", model: { id: "m1", compat: { a: 1 } }, key: "sk-secret" },
			mcp: { srv: { description: "d", toolExposure: { t: "eager" } } },
			thinking: "off",
			files: { "w/f.txt": "hello" },
		}).start({ gatewayUrl: gw.url, mcpUrls: { srv: "http://127.0.0.1:1/mcp" }, env: { EXTRA: "1" } });
		const r = await session.run({ prompts: ["one", "two"], env: { EXTRA: "2" } });
		await session.close();
		const out = r.events[0] as Record<string, any>;
		expect(out.argv).toEqual([
			"--mode",
			"json",
			"--no-session",
			"--offline",
			"--trust",
			"--model",
			"prov/m1",
			"--thinking",
			"off",
			"one",
			"two",
		]);
		expect(out.key).toBe("sk-secret");
		expect(out.extra).toBe("2");
		const models = JSON.parse(out.models).providers.prov;
		expect(models).toMatchObject({
			baseUrl: gw.url,
			api: "anthropic-messages",
			apiKey: "$TESTKIT_PROVIDER_KEY",
			models: [{ id: "m1", compat: { a: 1 } }],
		});
		expect(out.models).not.toContain("sk-secret");
		const srv = JSON.parse(out.mcp).mcpServers.srv;
		expect(srv).toMatchObject({ url: "http://127.0.0.1:1/mcp", description: "d", toolExposure: { t: "eager" } });
		// No identity headers: a fixed "main" would attribute every child's MCP call to main.
		expect(srv.headers).toBeUndefined();
		expect(JSON.parse(out.settings)).toEqual({ theme: "x" });
		expect(out.skill).toBe("# skill");
		expect(out.file).toBe("hello");
		expect(r.stderr).toBe("leak <key>\n");
	});

	it("defaults to the testkit provider and string input", async () => {
		const session = await octocodeAgentAdapter({ bundle: fakeBundle() }).start({
			gatewayUrl: "http://127.0.0.1:9",
			files: { "w/f.txt": "ctx" },
		});
		const r = await session.run("solo");
		await session.close();
		const out = r.events[0] as Record<string, any>;
		expect(out.argv.slice(-3)).toEqual(["--model", "testkit/scripted", "solo"]);
		expect(out.argv).toContain("--no-session");
		expect(out.key).toBeNull();
	});

	it("persistSession drops --no-session", async () => {
		const session = await octocodeAgentAdapter({ bundle: fakeBundle(), persistSession: true }).start({
			gatewayUrl: "http://127.0.0.1:9",
		});
		const r = await session.run("solo");
		await session.close();
		const out = r.events[0] as Record<string, any>;
		expect(out.argv).toEqual(["--mode", "json", "--offline", "--trust", "--model", "testkit/scripted", "solo"]);
	});
});

describe("one prompt per run", () => {
	it("claude-code and codex reject several prompts", async () => {
		for (const [name, adapter] of [
			["claude-code", claudeCodeAdapter({ command: "true" })],
			["codex", codexAdapter({ command: "true" })],
		] as const) {
			const s = await adapter.start({ gatewayUrl: "http://127.0.0.1:9", files: { "x/y.txt": "1" } });
			await expect(s.run({ prompts: ["a", "b"] })).rejects.toThrow(`${name} adapter: one prompt per run`);
			await s.close();
		}
	});

	it("claude-code writes ctx.files into the workspace", async () => {
		const ws = tmp();
		mkdirSync(ws, { recursive: true });
		const s = await claudeCodeAdapter({ command: "true" }).start({
			gatewayUrl: "http://127.0.0.1:9",
			workdir: ws,
			files: { "x/y.txt": "1" },
		});
		await s.close();
		expect(readFileSync(join(ws, "x/y.txt"), "utf8")).toBe("1");
	});

	it("reference runs prompts one after another", async () => {
		const gw = await gateway({ responder: script([{ text: "first" }, { text: "second" }]) });
		const s = await referenceAdapter({ trace: new Trace() }).start({ gatewayUrl: gw.url });
		const r = await s.run({ prompts: ["p1", "p2"] });
		expect(r.answer).toBe("second");
		expect(gw.trace.requests).toHaveLength(2);
		await s.close();
	});
});
