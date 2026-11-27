import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInproc, type Skill } from "../../src/agents/inproc.ts";
import { parseSkillListing, runOctocodeAgent, skillToolDescription } from "../../src/adapters/octocode-agent/index.ts";
import { script } from "../../src/gateway.ts";
import { NoAnswer, runTrials, type LiveSummary } from "../../src/live.ts";
import { forwardOf, resolveTier, type Tier } from "../../src/tiers.ts";
import { requireBundle } from "../guards/support.ts";
import { gateway } from "../helpers.ts";
import { writeComparison } from "./compare.ts";
import { PROMPTS, UNRELATED } from "./matrix.ts";

const TMP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.octocode/tmp");
const resolved = resolveTier();

/** Mirrors the `skill` tool's description wording, with the inproc agent's `load_skill` as the tool. */
const SYSTEM =
	"You are a coding assistant. Call load_skill (one call per name) to load a skill when its description matches the work at hand " +
	"(a shared word is not a match); several can apply. If no skill matches, answer directly without calling load_skill.";

interface Spend {
	input: number;
	output: number;
	cached: number;
	calls: number;
	retries: number;
}

/** Transport failures (timeout, 429, 5xx) say nothing about the skill description: retry them, then fail the trial loudly. */
async function loadedSkills(
	tier: Tier,
	spend: Spend,
	skills: Skill[],
	prompt: string,
	sample: number,
): Promise<string[]> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await loadedSkillsOnce(tier, spend, skills, prompt, sample);
		} catch (e) {
			if (attempt >= 1) throw e;
			spend.retries++;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

async function loadedSkillsOnce(
	tier: Tier,
	spend: Spend,
	skills: Skill[],
	prompt: string,
	sample: number,
): Promise<string[]> {
	const gw = await gateway({ forward: forwardOf(tier), cassette: { sample } });
	await runInproc(
		{
			gatewayUrl: gw.url,
			trace: gw.trace,
			skills,
			maxTurns: 1,
			systemPrompt: SYSTEM,
			body: { max_tokens: 512, ...tier.body },
		},
		prompt,
	);
	for (const r of gw.trace.requests) {
		spend.calls++;
		spend.input += r.usage?.promptTokens ?? 0;
		spend.cached += r.usage?.cachedTokens ?? 0;
		spend.output += r.usage?.completionTokens ?? 0;
	}
	if (!gw.trace.requests.length || gw.errors.length)
		throw new Error(`gateway: ${gw.errors.join("; ") || "no requests"}`);
	return gw.trace.of("skill_load").map((e) => e.name ?? "");
}

/** Run `jobs` with at most `limit` in flight. */
async function pool(limit: number, jobs: (() => Promise<void>)[]): Promise<void> {
	const queue = [...jobs];
	await Promise.all(
		Array.from({ length: Math.min(limit, queue.length) }, async () => {
			for (let job = queue.shift(); job; job = queue.shift()) await job();
		}),
	);
}

describe("skill trigger matrix (bundled skill descriptions, per model tier)", () => {
	it("records per-skill fire and near-miss rates (rates never fail the run)", async (ctx) => {
		if ("skip" in resolved) return ctx.skip(resolved.skip);
		const tier = resolved.tier;
		requireBundle(ctx);
		// Paid tiers spend more per prompt, so the Bayesian stop matters: pass threshold 0.5 at 90% confidence.
		const trial = {
			maxTrials: Number(process.env.TESTKIT_TRIGGER_TRIALS ?? (tier.remote ? 13 : 3)),
			minTrials: 1,
			threshold: 0.5,
			confidence: 0.9,
		};
		const budget = Number(process.env.TESTKIT_TOKEN_BUDGET ?? 0) || Infinity;
		const spend: Spend = { input: 0, output: 0, cached: 0, calls: 0, retries: 0 };
		const skippedForBudget: string[] = [];
		const overBudget = (): boolean => spend.input >= budget;
		const limit = Number(process.env.TESTKIT_CONCURRENCY ?? 0) || (tier.remote ? 4 : 1);

		// The real skill descriptions come from a captured request of the bundle (isolated HOME, no model).
		const cap = await gateway({ responder: script([{ text: "ok" }]) });
		await runOctocodeAgent({ gatewayUrl: cap.url, prompt: "hi" });
		const listed = parseSkillListing(skillToolDescription(cap.trace.requests[0].raw));
		expect(listed.length).toBeGreaterThan(0);
		const skills: Skill[] = listed.map((s) => ({ ...s, body: `${s.name} skill body (instructions omitted).` }));
		const missing = listed.map((s) => s.name).filter((n) => !PROMPTS[n]);

		const rows: Record<
			string,
			{
				fire?: LiveSummary;
				nearMiss?: LiveSummary;
				loadedOnFire: string[];
				fireErrors: number;
				nearMissErrors: number;
			}
		> = {};
		/** Count a transport failure (after retries) as an error, never as a fire or a miss. */
		const guarded = async <T>(onError: () => void, run: () => Promise<T>): Promise<T> => {
			try {
				return await run();
			} catch (e) {
				onError();
				throw new NoAnswer(e instanceof Error ? e.message : String(e));
			}
		};
		const unrelated: Record<string, LiveSummary> = {};
		const timeoutNote = (s: LiveSummary): string => (s.lastError ? ` last error: ${s.lastError.slice(0, 80)}` : "");
		const jobs: (() => Promise<void>)[] = [];
		for (const [name, p] of Object.entries(PROMPTS)) {
			if (!listed.some((s) => s.name === name)) continue;
			rows[name] = { loadedOnFire: [], fireErrors: 0, nearMissErrors: 0 };
			jobs.push(async () => {
				if (overBudget()) return void skippedForBudget.push(`${name}/fire`);
				const wrong: string[] = [];
				const f = await runTrials(trial, async ({ trial: n }) => {
					const loaded = await guarded(
						() => rows[name].fireErrors++,
						() => loadedSkills(tier, spend, skills, p.fire, n),
					);
					wrong.push(...loaded.filter((n) => n !== name));
					return loaded.includes(name);
				});
				rows[name].fire = f;
				rows[name].loadedOnFire = [...new Set(wrong)];
				console.info(`[triggers:${tier.name}] ${name} fire ${f.successes}/${f.trials} ${f.decision}${timeoutNote(f)}`);
			});
			jobs.push(async () => {
				if (overBudget()) return void skippedForBudget.push(`${name}/nearMiss`);
				const s = await runTrials(
					trial,
					async ({ trial: n }) =>
						!(
							await guarded(
								() => rows[name].nearMissErrors++,
								() => loadedSkills(tier, spend, skills, p.nearMiss, n),
							)
						).includes(name),
				);
				rows[name].nearMiss = s;
				console.info(
					`[triggers:${tier.name}] ${name} near-miss clean ${s.successes}/${s.trials} ${s.decision}${timeoutNote(s)}`,
				);
			});
		}
		for (const prompt of UNRELATED)
			jobs.push(async () => {
				if (overBudget()) return void skippedForBudget.push(`unrelated`);
				unrelated[prompt] = await runTrials(
					trial,
					async ({ trial: n }) => (await loadedSkills(tier, spend, skills, prompt, n)).length === 0,
				);
			});
		mkdirSync(TMP, { recursive: true });
		/** Rewritten after every finished prompt, so a stopped run still leaves usable partial results. */
		const save = (): void =>
			writeFileSync(
				resolve(TMP, `skill-triggers-${tier.name}.json`),
				JSON.stringify(
					{
						tier: tier.name,
						model: tier.model,
						trial,
						spend,
						budget: Number.isFinite(budget) ? budget : null,
						skippedForBudget,
						skills: rows,
						unrelated,
						missingPrompts: missing,
					},
					null,
					2,
				),
			);
		await pool(
			limit,
			jobs.map((job) => async () => {
				await job();
				save();
			}),
		);
		save();
		writeComparison(resolve(TMP, "../.."));
		console.info(
			`[triggers:${tier.name}] ${spend.calls} calls, input ${spend.input} (cached ${spend.cached}), output ${spend.output}`,
		);
		const reachable = Object.values(rows).some((r) => (r.fire?.trials ?? 0) > 0 && r.fire?.lastError === undefined);
		expect(reachable, `tier ${tier.name} never answered`).toBe(true);
	}, 3_600_000);
});
