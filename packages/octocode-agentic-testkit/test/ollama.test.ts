import { describe, expect, it } from "vitest";
import { runInproc, type Skill } from "../src/agents/inproc.ts";
import { gateway } from "./helpers.ts";

const MODEL = process.env.TESTKIT_OLLAMA_MODEL ?? "bonsai-2:9b";
const BASE = process.env.TESTKIT_OLLAMA_URL ?? "http://localhost:11434/v1";

const skills: Skill[] = [
	{
		name: "pdf",
		description: "Use for any task that reads, merges, splits or fills PDF files.",
		body: "PDF skill: use the pdf tools.",
	},
	{
		name: "sql",
		description: "Use for writing, optimizing or explaining SQL queries and schemas.",
		body: "SQL skill: prefer CTEs.",
	},
];

const matrix = [
	{ prompt: "Merge report-a.pdf and report-b.pdf into one file.", expect: "pdf" },
	{ prompt: "Write a SQL query that returns the top 5 customers by revenue.", expect: "sql" },
	{ prompt: "Split chapter3.pdf into one file per page.", expect: "pdf" },
	{ prompt: "What is the capital of France?", expect: null },
] as const;

describe("ollama trigger matrix", () => {
	it("reports per-prompt skill trigger rates (never fails on a rate)", async (ctx) => {
		if (process.env.TESTKIT_OLLAMA !== "1")
			return ctx.skip("set TESTKIT_OLLAMA=1 (needs a local Ollama with the model)");
		const trials = Number(process.env.TESTKIT_OLLAMA_TRIALS ?? 2);
		const rows: string[] = [];
		for (const row of matrix) {
			let hit = 0;
			let wrong = 0;
			let calls = 0;
			let ms = 0;
			let cached = 0;
			let prompt = 0;
			for (let i = 0; i < trials; i++) {
				const gw = await gateway({ forward: { baseUrl: BASE, model: MODEL } });
				const t0 = Date.now();
				try {
					await runInproc({ gatewayUrl: gw.url, trace: gw.trace, skills, maxTurns: 3 }, row.prompt);
				} catch (e) {
					rows.push(`  error: ${String(e).slice(0, 200)}`);
				}
				ms += Date.now() - t0;
				const loaded = gw.trace.of("skill_load").map((e) => e.name);
				if (row.expect ? loaded.includes(row.expect) : loaded.length === 0) hit++;
				if (loaded.some((n) => n !== row.expect)) wrong++;
				calls += gw.trace.requests.length;
				for (const r of gw.trace.requests) {
					cached += r.usage?.cachedTokens ?? 0;
					prompt += r.usage?.promptTokens ?? 0;
				}
			}
			rows.push(
				`  ${row.expect ?? "none"} <- "${row.prompt}": ${hit}/${trials} correct, ${wrong} wrong-skill, ${calls} requests, ${Math.round(ms / trials)} ms/trial, real prompt tokens ${prompt} cached ${cached}`,
			);
		}
		console.info(`[ollama ${MODEL}]\n${rows.join("\n")}`);
		expect(rows.length).toBeGreaterThanOrEqual(matrix.length);
	}, 900_000);
});
