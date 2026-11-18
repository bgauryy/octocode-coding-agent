import "../bundle.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runOctocodecode } from "../../src/adapters/octocodecode/index.ts";
import type { Responder } from "../../src/gateway.ts";
import { promptShape, sections, type PromptShape } from "../../src/measure.ts";
import { textOf, type CapturedRequest } from "../../src/trace.ts";
import { requireBundle } from "../guards/support.ts";
import { gateway } from "../helpers.ts";

/**
 * Prompt shape of every octocodecode agent, measured on the real bundle over the Anthropic wire (so the agent's own
 * cache markers are visible): main's first request, and the first request of a child started by the `agent` tool for
 * each profile. Free and offline (scripted gateway). Runs only with TESTKIT_MEASURE=1; writes
 * `<TESTKIT_MEASURE_DIR>/<TESTKIT_MEASURE_LABEL>/{shape.json,report.md}` and, with TESTKIT_MEASURE_BASE=<label>, a
 * delta column against that earlier run.
 */

const ON = process.env.TESTKIT_MEASURE === "1";
const DIR = resolve(
	process.env.TESTKIT_MEASURE_DIR ?? join(import.meta.dirname, "../../../../.octocode/tmp/testkit-measure"),
);
const LABEL = process.env.TESTKIT_MEASURE_LABEL ?? new Date().toISOString().replace(/[:.]/g, "-");
const BASE = process.env.TESTKIT_MEASURE_BASE;

/** Child profiles; `general` starts a child without a profile. */
const PROFILES = ["general", "researcher", "implementer", "reviewer", "browser", "lean"] as const;

/** Text Octocode ships but does not own here: MCP server instructions, the sibling skill list, project AGENTS.md. */
const EXTERNAL = [
	/<mcp name="[^"]*"[^>]*>[\s\S]*?<\/mcp>/g,
	/<octocode_skills>[\s\S]*?<\/octocode_skills>/g,
	/<project_instructions [^>]*>[\s\S]*?<\/project_instructions>/g,
];

const isMain = (r: CapturedRequest): boolean => r.tools.includes("backlog");

function systemText(r: CapturedRequest): string {
	const sys = (r.raw as { system?: unknown }).system;
	return Array.isArray(sys) ? sys.map((b: { text?: string }) => b.text ?? "").join("") : String(sys ?? "");
}

interface AgentRow {
	agent: string;
	shape: PromptShape;
	externalBytes: number;
	ownedSystem: number;
	nativeDescription: number;
	schemaProse: number;
	schemaStructure: number;
	/** Owned system + native tool descriptions + native schema prose: the text a rewrite can shorten. */
	ownedProse: number;
	repeatedBytes: number;
	/** Prompt sections delivered as messages (such as a policy section added after the first child). */
	messageSections: { tag: string; bytes: number }[];
}

function row(agent: string, r: CapturedRequest): AgentRow {
	const shape = promptShape(r);
	const text = systemText(r);
	const externalBytes = EXTERNAL.reduce(
		(n, re) => n + [...text.matchAll(re)].reduce((k, m) => k + Buffer.byteLength(m[0]), 0),
		0,
	);
	const native = shape.tools.filter((t) => !t.name.startsWith("mcp__"));
	const sum = (k: "descriptionBytes" | "schemaProseBytes" | "schemaStructureBytes"): number =>
		native.reduce((n, t) => n + t[k], 0);
	const ownedSystem = shape.systemBytes - externalBytes;
	return {
		agent,
		shape,
		externalBytes,
		ownedSystem,
		nativeDescription: sum("descriptionBytes"),
		schemaProse: sum("schemaProseBytes"),
		schemaStructure: sum("schemaStructureBytes"),
		ownedProse: ownedSystem + sum("descriptionBytes") + sum("schemaProseBytes"),
		repeatedBytes: shape.repeated.reduce((n, x) => n + (x.count - 1) * Buffer.byteLength(x.text), 0),
		messageSections: r.messages
			.filter((m) => m.role !== "system")
			.flatMap((m) => sections(textOf(m.content)).sections.map(({ tag, bytes }) => ({ tag, bytes }))),
	};
}

/** The first request of main (no profile) or of the child of `profile`; `after` is main's last request of that run. */
async function capture(profile?: string): Promise<{ first: CapturedRequest; after: CapturedRequest }> {
	let mainTurns = 0;
	const responder: Responder = ({ request }) => {
		if (!request.tools.includes("backlog")) return { text: "done" };
		if (!profile || mainTurns++ > 0) return { text: "ok" };
		const args: Record<string, string> = {
			type: "task",
			reason: "measure",
			goal: "Measure",
			task: "Reply done.",
			model: "testkit/scripted",
		};
		if (profile !== "general") args.profile = profile;
		return { toolCalls: [{ name: "agent", args }] };
	};
	const gw = await gateway({ responder });
	const run = await runOctocodecode({ gatewayUrl: gw.url, prompt: "hi", api: "anthropic-messages", timeoutMs: 90_000 });
	expect(run.exitCode, run.stderr.slice(-2000)).toBe(0);
	const found = profile ? gw.trace.requests.find((r) => !isMain(r)) : gw.trace.requests.find(isMain);
	expect(found, `${profile ?? "main"}: no request captured; stderr: ${run.stderr.slice(-1500)}`).toBeDefined();
	return { first: found!, after: gw.trace.requests.filter(isMain).at(-1)! };
}

const pct = (now: number, was?: number): string => (was ? `${(((now - was) / was) * 100).toFixed(0)}%` : "");

function report(rows: AgentRow[], base?: AgentRow[]): string {
	const was = (a: string): AgentRow | undefined => base?.find((b) => b.agent === a);
	const lines = [
		`# Prompt shape: ${LABEL}${BASE ? ` (Δ vs ${BASE})` : ""}`,
		"",
		"Bytes of the first request. Owned prose = owned system + native tool descriptions + schema prose.",
		"",
		"| agent | system | external | owned system | tool desc | schema prose | schema JSON | owned prose | Δ | repeated | blocks (bytes:cache) | markers t/s/m |",
		"|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|---|",
	];
	for (const r of rows)
		lines.push(
			`| ${r.agent} | ${r.shape.systemBytes} | ${r.externalBytes} | ${r.ownedSystem} | ${r.nativeDescription} | ${r.schemaProse} | ${r.schemaStructure} | ${r.ownedProse} | ${pct(r.ownedProse, was(r.agent)?.ownedProse)} | ${r.repeatedBytes} | ${r.shape.blocks.map((b) => `${b.bytes}:${b.cacheControl ?? "-"}`).join(" ")} | ${[r.shape.markers.tools, r.shape.markers.system, r.shape.markers.messages].map((m) => m.join(",") || "-").join(" / ")} |`,
		);
	const main = rows.find((r) => r.agent === "main");
	if (main) {
		lines.push("", "## main sections", "", "| block | section | bytes |", "|--:|---|--:|");
		for (const b of main.shape.blocks)
			for (const s of b.sections) lines.push(`| ${b.index} | ${s.tag}${s.attrs ? ` ${s.attrs}` : ""} | ${s.bytes} |`);
		lines.push("", "## main tools", "", "| tool | desc | schema prose | schema JSON |", "|---|--:|--:|--:|");
		for (const t of [...main.shape.tools].sort(
			(a, b) => b.descriptionBytes + b.schemaProseBytes - a.descriptionBytes - a.schemaProseBytes,
		))
			lines.push(`| ${t.name} | ${t.descriptionBytes} | ${t.schemaProseBytes} | ${t.schemaStructureBytes} |`);
	}
	lines.push("", "## Cached prefix at each breakpoint", "", "| agent | breakpoints (at: prefix bytes) |", "|---|---|");
	for (const r of rows)
		lines.push(`| ${r.agent} | ${r.shape.cachedPrefixes.map((p) => `${p.at}: ${p.bytes}`).join(" → ") || "none"} |`);
	lines.push("", "## Sections sent as messages", "");
	for (const r of rows)
		if (r.messageSections.length)
			lines.push(`- ${r.agent}: ${r.messageSections.map((s) => `${s.tag} ${s.bytes}`).join(", ")}`);
	lines.push("", "## Repeated sentences (main)", "");
	for (const x of main?.shape.repeated ?? [])
		lines.push(`- ×${x.count} ${x.where.join(", ")}: ${x.text.slice(0, 120)}`);
	return `${lines.join("\n")}\n`;
}

describe.skipIf(!ON)("prompt shape (TESTKIT_MEASURE=1, real bundle, Anthropic wire)", () => {
	it("measures main and every child profile", { timeout: 900_000 }, async (ctx) => {
		requireBundle(ctx);
		const rows = [row("main", (await capture()).first)];
		for (const p of PROFILES) {
			const { first, after } = await capture(p);
			rows.push(row(p, first));
			// Main's system prompt after its first child gains the `children` policy.
			if (p === "general") rows.splice(1, 0, row("main-after-child", after));
		}
		const out = join(DIR, LABEL);
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "shape.json"), `${JSON.stringify(rows, null, 2)}\n`);
		const baseFile = BASE ? join(DIR, BASE, "shape.json") : undefined;
		const base =
			baseFile && existsSync(baseFile) ? (JSON.parse(readFileSync(baseFile, "utf8")) as AgentRow[]) : undefined;
		writeFileSync(join(out, "report.md"), report(rows, base));
		console.info(`[measure] ${out}/report.md`);
		for (const r of rows) expect(r.shape.blocks.length, `${r.agent} has system blocks`).toBeGreaterThan(0);
	});
});
