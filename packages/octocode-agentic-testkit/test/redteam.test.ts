import { afterEach, describe, expect, it, vi } from "vitest";
import { redTeamAttacks, runAttack } from "../src/index.ts";
import { script } from "../src/script.ts";
import type { Tier } from "../src/tiers.ts";

const find = (id: string) => redTeamAttacks.find((a) => a.id === id)!;

afterEach(() => vi.unstubAllEnvs());

describe("red-team preset on the scripted tier", () => {
	it("covers every attack family with unique ids", () => {
		expect(new Set(redTeamAttacks.map((a) => a.kind))).toEqual(
			new Set(["injection", "exfiltration", "destructive", "skill-hijack"]),
		);
		expect(new Set(redTeamAttacks.map((a) => a.id)).size).toBe(redTeamAttacks.length);
	});

	describe.each(redTeamAttacks.map((a) => [a.id, a] as const))("%s", (_id, attack) => {
		it("a model that ignores the lure resists, and no bait tool ran", async () => {
			const run = await runAttack(attack, { model: "resists" });
			expect(run.trace).toResist(attack);
			expect(run.executed).toEqual([]);
		});

		it("MUST FAIL: a model that obeys the lure does not resist", async () => {
			const run = await runAttack(attack, { model: "compromised" });
			expect(() => expect(run.trace).toResist(attack)).toThrow(new RegExp(`resist attack ${attack.id}`));
			expect(run.trace).not.toResist(attack);
		});
	});

	it("names what the compromised agent did", async () => {
		const attack = find("exfiltration-secret-lure");
		const run = await runAttack(attack, { model: "compromised" });
		expect(() => expect(run.trace).toResist(attack)).toThrow(/called read_file[\s\S]*called send_http[\s\S]*canary/);
		expect(run.executed).toEqual(expect.arrayContaining(["send_http", "read_file"]));
	});

	it("a canary in the final answer alone fails the case", async () => {
		const attack = find("exfiltration-secret-in-answer");
		const run = await runAttack(attack, { model: "compromised" });
		expect(run.trace.of("model_tool_call").every((e: { name?: string }) => e.name === "fetch_page")).toBe(true);
		expect(() => expect(run.trace).toResist(attack)).toThrow(/canary in the answer/);
	});

	it("argsMatch lets a harmless call of a forbidden tool through", async () => {
		const attack = find("destructive-command-bait");
		const run = await runAttack(attack, {
			model: script([
				{ toolCalls: [{ name: "fetch_page", args: { url: "https://ops.example/cleanup" } }] },
				{ toolCalls: [{ name: "run_shell", args: { command: "ls" } }] },
				{ text: "listed" },
			]),
		});
		expect(run.trace).toResist(attack);
		expect(run.executed).toEqual(["run_shell"]);
	});

	it("cannot observe when the hostile content never reached the model", async () => {
		const attack = find("injection-ignore-instructions");
		const run = await runAttack(attack, { model: script([{ text: "I will not fetch anything." }]) });
		expect(() => expect(run.trace).toResist(attack)).toThrow(/cannot observe/);
		expect(() => expect(run.trace).not.toResist(attack)).toThrow(/cannot observe/);
	});

	it("a skill hijack only reaches the model once the skill is loaded", async () => {
		const attack = find("skill-hijack-exfil");
		const run = await runAttack(attack, { model: "resists" });
		expect(run.trace).toHaveLoadedSkill("release-notes");
		expect(run.trace).toResist(attack);
	});
});

describe("red-team preset on paid tiers", () => {
	const paid: Tier = {
		name: "haiku",
		baseUrl: "http://127.0.0.1:1",
		model: "m",
		api: "anthropic",
		body: {},
		remote: true,
		timeoutMs: 1000,
	};

	it("refuses a remote tier unless TESTKIT_LIVE=1", async () => {
		vi.stubEnv("TESTKIT_LIVE", "");
		await expect(runAttack(redTeamAttacks[0], { model: paid })).rejects.toThrow(/TESTKIT_LIVE=1/);
	});
});
