import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "../src/client/index.ts";
import { createBrowserGuard } from "../src/presets/browser/proxy.ts";
import { defineBrowserTool } from "../src/presets/browser/tools.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, tail]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 0, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 128)]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeProxy = async () => ({ port: 1, url: "http://127.0.0.1:1", close: async () => {} }) as never;

describe("browser calls reach the server in call order", () => {
	it("prepares a parallel open and snapshot in call order although open is slow", async () => {
		const guard = createBrowserGuard({
			running: async () => {
				await sleep(60);
				return false;
			},
			start: fakeProxy,
		});
		const order: string[] = [];
		const cwd = tmp();
		const calls = [
			guard.call("open", { args: [] }, cwd).then(() => order.push("open")),
			guard.call("snapshot", {}, cwd).then(() => order.push("snapshot")),
			guard.call("run", {}, cwd).then(() => order.push("run")),
		];
		await Promise.all(calls);
		expect(order).toEqual(["open", "snapshot", "run"]);
		await guard.dispose();
	});

	it("does not let a failed call block the ones after it", async () => {
		let starts = 0;
		const guard = createBrowserGuard({
			running: async () => false,
			start: async () => {
				if (starts++ === 0) throw new Error("proxy refused");
				return fakeProxy();
			},
		});
		const cwd = tmp();
		const first = guard.call("open", { args: [] }, cwd);
		const second = guard.call("snapshot", {}, cwd);
		await expect(first).rejects.toThrow("proxy refused");
		await expect(second).resolves.toMatchObject({ args: {} });
	});

	it("does not let a cancelled call block the queue, and keeps later calls behind earlier ones", async () => {
		const guard = createBrowserGuard({
			running: async () => {
				await sleep(40);
				return false;
			},
			start: fakeProxy,
		});
		const cwd = tmp();
		const controller = new AbortController();
		const order: string[] = [];
		const open = guard.call("open", { args: [] }, cwd).then(() => order.push("open"));
		const cancelled = guard.call("snapshot", {}, cwd, controller.signal);
		const last = guard.call("run", {}, cwd).then(() => order.push("run"));
		controller.abort(new Error("stop"));
		await expect(cancelled).rejects.toThrow("stop");
		await Promise.all([open, last]);
		expect(order).toEqual(["open", "run"]);
		await expect(guard.call("snapshot", {}, cwd, AbortSignal.abort(new Error("early")))).rejects.toThrow("early");
		await expect(guard.call("snapshot", {}, cwd)).resolves.toBeDefined();
		await guard.dispose();
	});
});

describe("dev-check only reuses a browser behind the filter", () => {
	it("refuses before sending when no browser runs, or one runs without the filter", async () => {
		const cwd = tmp();
		const none = createBrowserGuard({ running: async () => false, start: fakeProxy });
		await expect(none.call("dev-check", { url: "http://localhost:3000", port: 9301 }, cwd)).rejects.toThrow(
			"call open with port 9301 first",
		);
		const unfiltered = createBrowserGuard({ running: async () => true, start: fakeProxy });
		await expect(unfiltered.call("dev-check", { url: "http://localhost:3000" }, cwd)).rejects.toThrow(
			"call open with port 9222 first",
		);
	});

	it("runs against the browser open started behind the filter", async () => {
		const cwd = tmp();
		let up = false;
		const guard = createBrowserGuard({ running: async () => up, start: fakeProxy });
		await guard.call("open", { port: 9302, args: [] }, cwd);
		up = true;
		await expect(guard.call("dev-check", { url: "http://localhost:3000", port: 9302 }, cwd)).resolves.toMatchObject({
			args: { port: 9302 },
		});
		await guard.dispose();
	});
});

function harness(toolName: string, reply: () => CallToolResult) {
	const definition = defineBrowserTool({
		server: "browser",
		tool: { name: toolName, inputSchema: { type: "object", properties: {} } },
		name: `mcp__browser__${toolName}`,
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => ({ callTool: async () => reply() }),
	});
	return (cwd: string) => definition.execute("call", {}, undefined, undefined, { cwd, model: undefined } as never);
}

const captureRoot = (cwd: string, ...parts: string[]) => {
	const dir = join(cwd, ".octocode", "octocode-chrome-devtools", "tmp", ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
const imagesOf = (result: { content: Array<{ type: string }> }) =>
	result.content.filter((part) => part.type === "image");

describe("browser failure cause and help inline", () => {
	const adapter = (cwd: string, files: Record<string, string>) => {
		const dir = captureRoot(cwd, "adapter", "abc");
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
		return { stdout: join(dir, "stdout.txt"), stderr: join(dir, "stderr.txt") };
	};

	it("appends the engine's stderr lines to a failed result, without launch noise", async () => {
		const cwd = tmp();
		const logs = adapter(cwd, {
			"stdout.txt": "",
			"stderr.txt":
				"[CDP_SANDBOX] sandboxed (node 26.4.0)\n(node:1) ExperimentalWarning: The flag --allow-net\n[CDP_RUNNER] Chrome not responding on port 9222. Run open-browser.mjs first.\n",
		});
		const run = harness("snapshot", () => ({
			content: [{ type: "text", text: "Failed; inspect capture before retrying." }],
			isError: true,
			structuredContent: { ok: false, exitCode: 1, logs },
		}));
		const text = textOf(await run(cwd));
		expect(text).toContain("Chrome not responding on port 9222");
		expect(text).not.toContain("ExperimentalWarning");
		expect(text).not.toContain("sandboxed");
	});

	it("keeps only the last lines of a long stderr, clipped", async () => {
		const cwd = tmp();
		const many = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n");
		const logs = adapter(cwd, { "stderr.txt": many });
		const run = harness("run", () => ({
			content: [{ type: "text", text: "Failed" }],
			structuredContent: { ok: false, logs },
		}));
		const text = textOf(await run(cwd));
		expect(text).toContain("line 99");
		expect(text).not.toContain("line 10 ");
		expect(text.length).toBeLessThan(4500);
	});

	it("adds failure.error from browser-result.json", async () => {
		const cwd = tmp();
		const dir = captureRoot(cwd, "2026-11-04-10-00-00");
		writeFileSync(join(dir, "browser-result.json"), JSON.stringify({ failure: { error: "Unsupported option out" } }));
		const run = harness("run", () => ({
			content: [{ type: "text", text: "Failed" }],
			structuredContent: { ok: false, root: dir, artifacts: [{ label: "r", path: "browser-result.json" }] },
		}));
		expect(textOf(await run(cwd))).toContain("Failure: Unsupported option out");
	});

	it("includes help text from stdout (or stderr for helpers that print it there)", async () => {
		const cwd = tmp();
		for (const files of [
			{ "stdout.txt": "Usage: snapshot-query.mjs --file <f>\nPages saved evidence.", "stderr.txt": "" },
			{ "stdout.txt": "", "stderr.txt": "Usage: prune-artifacts.mjs [--dry-run]" },
			{ "stdout.txt": "[PRUNE] Usage: node prune-artifacts.mjs [--max-age-days 3]", "stderr.txt": "" },
		]) {
			const logs = adapter(cwd, files);
			const run = harness("snapshot_query", () => ({
				content: [{ type: "text", text: "OK" }],
				structuredContent: { ok: true, artifacts: [], logs },
			}));
			expect(textOf(await run(cwd))).toMatch(/Help text:\n(\[PRUNE\] )?Usage: /);
		}
	});

	it("includes the stdout of a helper that saved nothing, such as a HAR page", async () => {
		const cwd = tmp();
		const logs = adapter(cwd, {
			"stdout.txt": "[HAR_PAGE] filter=failures page=1/1 rows=0 allEntries=7",
			"stderr.txt": "",
		});
		const run = harness("har_pager", () => ({
			content: [{ type: "text", text: "OK" }],
			structuredContent: { ok: true, capture: { artifacts: 0, findings: 0 }, logs },
		}));
		expect(textOf(await run(cwd))).toContain("Output:\n[HAR_PAGE] filter=failures");
	});

	it("adds nothing to a successful result, and ignores logs outside the capture folder", async () => {
		const cwd = tmp();
		const outside = join(cwd, "outside.txt");
		writeFileSync(outside, "secret failure");
		const ok = harness("snapshot", () => ({
			content: [{ type: "text", text: "OK" }],
			structuredContent: { ok: true, logs: adapter(cwd, { "stdout.txt": "{}", "stderr.txt": "warn" }) },
		}));
		expect(textOf(await ok(cwd))).not.toContain("stderr (last lines)");
		const bad = harness("snapshot", () => ({
			content: [{ type: "text", text: "Failed" }],
			structuredContent: { ok: false, logs: { stderr: outside } },
		}));
		expect(textOf(await bad(cwd))).not.toContain("secret failure");
	});
});

describe("viewport and duplicate screenshots", () => {
	const reply = (structuredContent: Record<string, unknown>): CallToolResult => ({
		content: [{ type: "text", text: "OK" }],
		structuredContent,
	});

	it("attaches the image of a viewport manifest whose tile is an absolute path under `path`", async () => {
		const cwd = tmp();
		const dir = captureRoot(cwd, "shot");
		writeFileSync(join(dir, "screenshot.png"), png(8, 8));
		writeFileSync(
			join(dir, "screenshot-manifest.json"),
			JSON.stringify({ mode: "viewport", tiles: [{ index: 1, path: join(dir, "screenshot.png") }] }),
		);
		const run = harness("screenshot", () =>
			reply({ ok: true, artifacts: [{ path: join(dir, "screenshot-manifest.json") }] }),
		);
		expect(imagesOf(await run(cwd))).toHaveLength(1);
	});

	it("attaches the image beside a manifest that lists no tiles", async () => {
		const cwd = tmp();
		const dir = captureRoot(cwd, "shot");
		writeFileSync(join(dir, "screenshot.png"), png(8, 8));
		writeFileSync(join(dir, "screenshot-manifest.json"), JSON.stringify({ mode: "viewport", complete: true }));
		const run = harness("screenshot", () =>
			reply({ ok: true, root: dir, artifacts: [{ path: "screenshot-manifest.json" }] }),
		);
		expect(imagesOf(await run(cwd))).toHaveLength(1);
	});

	it("attaches one image when two files hold the same capture", async () => {
		const cwd = tmp();
		const dir = captureRoot(cwd, "shot");
		writeFileSync(join(dir, "a.png"), png(8, 8));
		copyFileSync(join(dir, "a.png"), join(dir, "b.png"));
		const run = harness("screenshot", () =>
			reply({ ok: true, root: dir, artifacts: [{ path: "a.png" }, { path: "b.png" }] }),
		);
		const result = await run(cwd);
		expect(imagesOf(result)).toHaveLength(1);
		expect(textOf(result)).toContain("same image as above");
	});
});
