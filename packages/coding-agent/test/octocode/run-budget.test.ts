import { expect, it } from "vitest";
import { loopNote } from "../../src/octocode/loop-guard.ts";
import { registerRunBudget, runRequestLimit, UNATTENDED_MAX_REQUESTS } from "../../src/octocode/run-budget.ts";
import { inRecentUse } from "../../src/octocode/compaction/clearing-recent.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

type Verdict = { block?: boolean; terminate?: boolean; reason?: string } | undefined;

/** A run of `replies` assistant replies, each followed by one tool call; returns each call's verdict and result text. */
async function run(
	settings: object,
	options: { hasUI: boolean; isSubagent?: boolean; confirms?: boolean[] },
	replies: number,
) {
	const fake = fakeHost(settings as Record<string, unknown>);
	const gate = registerRunBudget(fake.api, options.isSubagent ?? false);
	const ctx = fakeCtx({ cwd: "/repo", hasUI: options.hasUI, model: { provider: "p", id: "m" } });
	ctx.ui.confirms.push(...(options.confirms ?? []));
	const failed: string[] = [];
	ctx.failRun = (reason: string) => void failed.push(reason);
	await fake.fire("before_agent_start", {}, ctx);
	const verdicts: Verdict[] = [];
	const notes: string[] = [];
	for (let reply = 1; reply <= replies; reply++) {
		await fake.fire("message_end", { message: { role: "assistant", content: [] } }, ctx);
		const verdict: Verdict = await gate({ toolName: "bash", toolCallId: `c${reply}`, input: {} } as never, ctx);
		verdicts.push(verdict);
		if (verdict?.block) break;
		const result = (await fake.fire(
			"message_end",
			{ message: { role: "toolResult", toolCallId: `c${reply}`, toolName: "bash", content: [] } },
			ctx,
		)) as { message?: { content: Array<{ text: string }> } } | undefined;
		notes.push(result?.message?.content.map((part) => part.text).join("") ?? "");
	}
	return { verdicts, notes, failed };
}

it("has no request limit with a user present and one without", () => {
	expect(runRequestLimit(undefined, true)).toBe(0);
	expect(runRequestLimit(undefined, false)).toBe(UNATTENDED_MAX_REQUESTS);
	expect(runRequestLimit(40, true)).toBe(40);
	expect(runRequestLimit(0, false)).toBe(0);
});

it("notes at the limit once and ends an unattended run at 1.5 times it", async () => {
	const { verdicts, notes, failed } = await run({ limits: { run: { maxRequests: 10 } } }, { hasUI: false }, 30);
	expect(verdicts).toHaveLength(15);
	expect(verdicts.at(-1)).toMatchObject({ block: true, terminate: true });
	expect(verdicts.at(-1)?.reason).toContain("15");
	expect(notes.filter(Boolean)).toHaveLength(1);
	expect(notes[9]).toContain("10");
	expect(failed).toEqual(["Stopped by the request budget."]);
});

it("uses the limit of the model in use", async () => {
	const settings = { limits: { run: { maxRequests: 100 }, models: { "p/*": { run: { maxRequests: 4 } } } } };
	const { verdicts } = await run(settings, { hasUI: false }, 30);
	expect(verdicts).toHaveLength(6);
});

it("asks a present user, and a yes grants the limit again", async () => {
	const settings = { limits: { run: { maxRequests: 4 } } };
	const granted = await run(settings, { hasUI: true, confirms: [true] }, 30);
	// Stopped at 6, granted 4 more: the next stop is at 10, where nobody says yes.
	expect(granted.verdicts).toHaveLength(10);
	expect(granted.notes.filter(Boolean)).toHaveLength(2);
	const refused = await run(settings, { hasUI: true, confirms: [false] }, 30);
	expect(refused.verdicts).toHaveLength(6);
});

it("counts nothing for a subagent, a present user without a limit, or a limit of 0", async () => {
	for (const [settings, options] of [
		[{ limits: { run: { maxRequests: 2 } } }, { hasUI: false, isSubagent: true }],
		[{}, { hasUI: true }],
		[{ limits: { run: { maxRequests: 0 } } }, { hasUI: false }],
	] as const) {
		const { verdicts, notes } = await run(settings, options, 20);
		expect(verdicts.every((verdict) => verdict === undefined)).toBe(true);
		expect(notes.filter(Boolean)).toEqual([]);
	}
});

it("takes the loop counts and the clearing window as parameters", () => {
	expect(loopNote("bash", 3, false)).toBeDefined();
	expect(loopNote("bash", 3, false, { noteAt: 4, stopAt: 6, haltAt: 9 })).toBeUndefined();
	expect(loopNote("bash", 4, false, { noteAt: 4, stopAt: 6, haltAt: 9 })).toBeDefined();
	const messages = Array.from({ length: 6 }, () => ({ message: { role: "assistant", content: [] } }));
	const candidates = [{ id: "old", index: 1, text: "x" }];
	expect(inRecentUse(candidates as never, messages as never, new Map()).has("old")).toBe(true);
	expect(inRecentUse(candidates as never, messages as never, new Map(), { keepTurns: 2 }).has("old")).toBe(false);
});
