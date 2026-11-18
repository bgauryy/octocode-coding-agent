import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { octocodecodeAdapter, octocodecodeAvailable } from "../src/adapters/octocodecode/index.ts";
import { referenceAdapter } from "../src/adapters/reference/index.ts";
import { script } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

/** A stand-in CLI: reports where it was pointed to, so the adapter's wiring is observable without the real bundle. */
function fakeBundle(): string {
	const dir = mkdtempSync(join(tmpdir(), "testkit-fake-bundle-"));
	const file = join(dir, "cli.js");
	writeFileSync(
		file,
		`const fs = require("node:fs");
const home = process.env.OCTOCODE_HOME;
console.log(JSON.stringify({ args: process.argv.slice(2), home, cwd: process.cwd(), models: fs.readFileSync(home + "/models.json", "utf8"), mcp: fs.existsSync(home + "/mcp.json") ? fs.readFileSync(home + "/mcp.json", "utf8") : null, extra: process.env.EXTRA }));`,
	);
	return file;
}

describe("octocodecode adapter", () => {
	it("needs a configured bundle", async () => {
		const saved = process.env.TESTKIT_OCTOCODECODE_BUNDLE;
		delete process.env.TESTKIT_OCTOCODECODE_BUNDLE;
		try {
			expect(octocodecodeAvailable()).toBe(false);
			await expect(octocodecodeAdapter().start({ gatewayUrl: "http://x" })).rejects.toThrow(
				/TESTKIT_OCTOCODECODE_BUNDLE/,
			);
		} finally {
			if (saved !== undefined) process.env.TESTKIT_OCTOCODECODE_BUNDLE = saved;
		}
	});

	it("writes models.json and mcp.json from the context, runs the bundle path it was given, and cleans up", async () => {
		const bundle = fakeBundle();
		expect(octocodecodeAvailable(bundle)).toBe(true);
		const session = await octocodecodeAdapter({ bundle, files: { "a/b.txt": "hi" } }).start({
			gatewayUrl: "http://127.0.0.1:1234",
			mcpUrls: { docs: "http://127.0.0.1:9/mcp" },
			env: { EXTRA: "1" },
		});
		const run = await session.run("hello");
		const out = run.events[0] as unknown as {
			args: string[];
			models: string;
			mcp: string;
			extra: string;
		};
		expect(out.args.at(-1)).toBe("hello");
		expect(JSON.parse(out.models).providers.testkit.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(JSON.parse(out.mcp).mcpServers.docs.url).toBe("http://127.0.0.1:9/mcp");
		expect(out.extra).toBe("1");
		expect(readFileSync(join(run.workspace, "a/b.txt"), "utf8")).toBe("hi");
		await session.close();
		expect(existsSync(run.home)).toBe(false);
	});
});

describe("reference adapter", () => {
	it("runs the in-process agent against the gateway", async () => {
		const gw = await gateway({ responder: script([{ text: "pong" }]) });
		const session = await referenceAdapter({ trace: gw.trace }).start({ gatewayUrl: gw.url });
		const r = await session.run("ping");
		await session.close();
		expect(r.answer).toBe("pong");
		expect(gw.trace.requests).toHaveLength(1);
	});

	it("connects mcpUrls as MCP clients", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "x" } }] }, { text: "done" }]),
		});
		const docs = mcp(gw, "docs", [searchTool]);
		const session = await referenceAdapter({ trace: gw.trace }).start({
			gatewayUrl: gw.url,
			mcpUrls: { docs: await docs.listen() },
		});
		await session.run("find x");
		await session.close();
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "x" }, before: "answer" });
	});

	it("keeps one conversation across runs with conversation: true", async () => {
		const gw = await gateway({ responder: script([{ text: "first" }, { text: "second" }]) });
		const session = await referenceAdapter({ trace: gw.trace, conversation: true }).start({ gatewayUrl: gw.url });
		await session.run("one");
		const r = await session.run("two");
		await session.close();
		expect(r.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
		expect(gw.trace).toKeepStablePrefix();
	});
});
