import type { Question, Reply } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { registerRender } from "../../src/octocode/native/tools/render/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const host = fakeHost();
registerRender(host.api, { isSubagent: false });
const render = host.tools.get("render");

/** A host that draws questions itself (as the web and RPC do): `answer` replies to what it was asked. */
function session(answer: (questions: Question[]) => Reply[], hasUI = true) {
	const asked: Question[][] = [];
	const ctx = Object.assign(
		fakeCtx({
			cwd: ".",
			hasUI,
			ui: {
				ask: async (questions: Question[]) => {
					asked.push(questions);
					return answer(questions);
				},
			} as never,
		}),
		{ mode: "rpc" },
	);
	return { ctx, asked };
}
const run = (params: object, ctx: unknown) => render.execute("1", params, undefined, undefined, ctx);
const pickFirst = (questions: Question[]): Reply[] =>
	questions.map((q) =>
		q.options?.length ? { id: q.id, picks: [q.options[0].id] } : { id: q.id, picks: [], text: "typed" },
	);

describe("render tool", () => {
	it("is not declared in a subagent session", () => {
		const child = fakeHost();
		registerRender(child.api, { isSubagent: true });
		expect(child.tools.has("render")).toBe(false);
	});

	it("draws a status or table without asking anything", async () => {
		const { ctx, asked } = session(pickFirst);
		const result = await run(
			{
				type: "table",
				title: "Totals",
				rows: [
					["a", "b"],
					["1", "22"],
				],
			},
			ctx,
		);
		expect(asked).toEqual([]);
		expect(result.content[0].text).toBe("Shown.");
		const shown = render.display({
			args: {
				type: "table",
				title: "Totals",
				rows: [
					["a", "b"],
					["1", "22"],
				],
			},
			result: result,
		});
		expect(shown.blocks[0].text).toBe("a  b\n-  --\n1  22");
	});

	it("asks for a confirm and reports a refusal as not accepted", async () => {
		const yes = session(pickFirst);
		const accepted = await run({ type: "confirm", title: "Deploy?" }, yes.ctx);
		expect(yes.asked[0]).toHaveLength(1);
		expect(accepted.details).toMatchObject({ accepted: true });
		const no = session((questions) => questions.map((q) => ({ id: q.id, cancelled: "declined" as const })));
		const refused = await run({ type: "confirm", title: "Deploy?" }, no.ctx);
		expect(refused.details).toMatchObject({ accepted: false });
		expect(refused.content[0].text).toContain("Not accepted");
	});

	it("asks a form as one batch and returns each field's answer", async () => {
		const { ctx, asked } = session(pickFirst);
		const result = await run(
			{
				type: "form",
				title: "Setup",
				fields: [
					{ id: "name", label: "Name?" },
					{ id: "env", label: "Env?", options: ["dev", "prod"] },
				],
			},
			ctx,
		);
		expect(asked[0].map((q) => q.id)).toEqual(["name", "env"]);
		expect(result.content[0].text).toContain("typed");
		expect(result.content[0].text).toContain("dev");
	});

	it("adds an accept step after a form only when permission is true", async () => {
		const fields = [{ id: "name", label: "Name?" }];
		const off = session(pickFirst);
		await run({ type: "form", title: "Setup", fields, permission: false }, off.ctx);
		expect(off.asked[0].map((q) => q.id)).toEqual(["name"]);
		const on = session(pickFirst);
		const result = await run({ type: "form", title: "Setup", fields, permission: true }, on.ctx);
		expect(on.asked[0].map((q) => q.id)).toEqual(["name", "proceed"]);
		expect(result.details).toMatchObject({ accepted: true });
	});

	it("a status with permission waits for the accept and never skips it", async () => {
		const declined = session((questions) => questions.map((q) => ({ id: q.id, cancelled: "declined" as const })));
		const result = await run({ type: "status", title: "About to wipe", permission: true }, declined.ctx);
		expect(declined.asked).toHaveLength(1);
		expect(result.details).toMatchObject({ accepted: false });
	});

	it("refuses without a UI, asking nothing", async () => {
		const { ctx, asked } = session(pickFirst, false);
		await expect(run({ type: "confirm", title: "Deploy?" }, ctx)).rejects.toThrow(/has none/);
		expect(asked).toEqual([]);
	});

	it("rejects a form with reserved or repeated ids", async () => {
		const { ctx } = session(pickFirst);
		const fields = [
			{ id: "a", label: "A" },
			{ id: "a", label: "B" },
		];
		await expect(run({ type: "form", title: "x", fields }, ctx)).rejects.toThrow(/repeated/);
	});

	it("is registered as a tool the main session owns", () => {
		expect(render.name).toBe("render");
	});
});
