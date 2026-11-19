import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter, cliMissing } from "../src/adapters/claude-code/index.ts";
import { CLAUDE_CODE_LIMITS } from "../src/adapters/claude-code/limits.ts";
import { script, startGateway } from "../src/gateway.ts";
import { recordMcp, type RecordedMcp } from "../src/mcp-record.ts";
import { analyzeSurface, surfaceOfRequest } from "../src/surface.ts";
import { Trace } from "../src/trace.ts";

/*
 * Worked example for MCP server and skill developers: a real MCP server under test, here octocode-mcp (stdio,
 * `octocode mcp`). Any server works the same way: swap `TARGET` for your own `{ command, args }` or `{ url }`. Every
 * test skips with a reason when the server's CLI (or Claude Code) is not installed.
 */

// Inside an Octocode Agent shell, `octocode` runs the agent and the research CLI is `octocode-cli`.
const TARGET = { command: cliMissing("octocode-cli") ? "octocode" : "octocode-cli", args: ["mcp"] };
const FILES = {
	"src/config.ts": "export function parseConfig(text: string) {\n\treturn JSON.parse(text);\n}\n",
	"src/app.ts": 'import { parseConfig } from "./config";\nexport const cfg = parseConfig("{}");\n',
};
const missing = (): string | undefined => cliMissing(TARGET.command);

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of closers.splice(0).reverse()) await c();
});

function workspace(): string {
	const ws = realpathSync(mkdtempSync(join(tmpdir(), "testkit-mcp-example-")));
	closers.push(() => rmSync(ws, { recursive: true, force: true }));
	return ws;
}

function server(trace: Trace, cwd: string): RecordedMcp {
	const rec = recordMcp({ name: "octocode", trace, target: { ...TARGET, cwd } });
	closers.push(() => rec.close());
	return rec;
}

const search = (ws: string) => ({
	queries: [{ path: ws, matchString: ["parseConfig"], mainGoal: "who calls parseConfig", reasoning: "find callers" }],
});

describe("worked example: an MCP server under test (octocode-mcp)", () => {
	it("its surface: what every request pays before the user types, and what a host truncates", async (ctx) => {
		const why = missing();
		if (why) return ctx.skip(why);
		const rec = server(new Trace(), workspace());
		await rec.ready();
		const report = analyzeSurface(
			{ servers: [rec], instructions: { octocode: rec.instructions ?? "" } },
			{ ...CLAUDE_CODE_LIMITS, contextWindowTokens: 200_000 },
		);
		const kinds = Object.fromEntries(
			[...new Set(report.issues.map((i) => i.kind))].map((k) => [k, report.issues.filter((i) => i.kind === k).length]),
		);
		console.info(
			`[mcp-example:surface] ${JSON.stringify({ tools: rec.defs.length, chars: report.totalChars, estTokens: report.estTokens, issues: kinds })}`,
		);
		expect(rec.defs.map((t) => t.name)).toEqual(expect.arrayContaining(["localSearch", "localFetch"]));
		// A real server must never carry hidden instructions in what the model reads.
		expect(report.issues.filter((i) => i.kind === "suspicious-instruction")).toEqual([]);
	});

	it("its contract, no model: results, sizes and latency per call", async (ctx) => {
		const why = missing();
		if (why) return ctx.skip(why);
		const ws = workspace();
		const { writeFiles } = await import("../src/process.ts");
		writeFiles(ws, FILES);
		const rec = server(new Trace(), ws);
		const r = await rec.client().callTool("localSearch", search(ws));
		expect(r.isError).toBe(false);
		expect(r.text).toContain("src/app.ts");
		const bad = await rec.client().callTool("localFetch", { queries: [{ path: join(ws, "missing.ts") }] });
		console.info(`[mcp-example:contract] ${JSON.stringify(rec.summary())} missing-file error: ${bad.isError}`);
		expect(rec.summary().byTool.localSearch.maxChars).toBeLessThan(20_000);
	});

	it("in a real harness, scripted: Claude Code calls it, reads the result, and the workflow is search then fetch", async (ctx) => {
		const why = missing() ?? cliMissing("claude");
		if (why) return ctx.skip(why);
		const ws = workspace();
		const gw = await startGateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__octocode__localSearch", args: search(ws) }] },
				{ toolCalls: [{ name: "mcp__octocode__localFetch", args: { queries: [{ path: join(ws, "src/app.ts") }] } }] },
				{ text: "src/app.ts calls parseConfig on line 2." },
			]),
		});
		closers.push(() => gw.close());
		const rec = server(gw.trace, ws);
		const session = await claudeCodeAdapter().start({
			gatewayUrl: gw.url,
			workdir: ws,
			files: FILES,
			mcpUrls: { octocode: await rec.listen() },
		});
		closers.push(() => session.close());
		const run = await session.run("who calls parseConfig?");
		expect(run.exitCode, run.stderr.slice(-500)).toBe(0);

		expect(gw.trace).toHaveCalledMcp("octocode", "localSearch", { before: "answer" });
		expect(gw.trace).toFollowTrajectory(["mcp__octocode__localSearch", "mcp__octocode__localFetch"], {
			mode: "ordered",
		});
		expect(gw.trace).toKeepEnvelopesUnder({ toolOutputChars: 20_000 });
		expect(rec.summary()).toMatchObject({ calls: 2, errors: 0 });
		// The model read the server's real answer in its next request.
		expect(JSON.stringify(gw.trace.requests[1].messages.at(-1))).toContain("src/app.ts");
		const first = gw.trace.requests[0];
		const own = surfaceOfRequest(first).filter((t) => t.name.startsWith("mcp__octocode__"));
		console.info(
			`[mcp-example:harness] ${JSON.stringify({
				requests: gw.trace.requests.length,
				deferredBehindToolSearch: own.length === 0 && first.tools.includes("ToolSearch"),
				calls: rec.calls().map((c) => ({ tool: c.tool, chars: c.chars, ms: Math.round(c.durationMs) })),
			})}`,
		);
	}, 120_000);

	it("with a skill: the harness lists it, the skill loads, and its workflow uses the server", async (ctx) => {
		const why = missing() ?? cliMissing("claude");
		if (why) return ctx.skip(why);
		const ws = workspace();
		const skill = [
			"---",
			"name: find-callers",
			"description: Use when the user asks who calls a function. Searches with localSearch, then reads the hit.",
			"---",
			"",
			"# Find callers",
			"1. localSearch for the function name.",
			"2. localFetch the calling file.",
		].join("\n");
		const gw = await startGateway({
			responder: script([
				{ toolCalls: [{ name: "Skill", args: { skill: "find-callers" } }] },
				{ toolCalls: [{ name: "mcp__octocode__localSearch", args: search(ws) }] },
				{ text: "src/app.ts calls it." },
			]),
		});
		closers.push(() => gw.close());
		const rec = server(gw.trace, ws);
		const session = await claudeCodeAdapter({ skills: { "find-callers": skill } }).start({
			gatewayUrl: gw.url,
			workdir: ws,
			files: FILES,
			mcpUrls: { octocode: await rec.listen() },
		});
		closers.push(() => session.close());
		const run = await session.run("who calls parseConfig?");
		expect(run.exitCode, run.stderr.slice(-500)).toBe(0);
		// The harness advertised the skill's description to the model before any call.
		expect(JSON.stringify(gw.trace.requests[0].raw)).toContain("Use when the user asks who calls a function");
		expect(gw.trace).toHaveLoadedSkill("find-callers");
		expect(gw.trace).toFollowTrajectory(["Skill", "mcp__octocode__localSearch"], { mode: "ordered" });
		expect(
			analyzeSurface({ skills: [{ name: "find-callers", description: skill.split("\n")[2].slice(13) }] }).issues,
		).toEqual([]);
	}, 120_000);
});
