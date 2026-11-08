import { describe, expect, it } from "vitest";
import { externalPermissionDialog } from "../../src/octocode/external/permission-dialog.ts";
import { ALLOW_ONCE, selectAnswer } from "../../src/octocode/permission/ask/text.ts";
import { fakeCtx } from "./fake-host.ts";

type Ctx = Parameters<typeof selectAnswer>[0];
const request = { title: "Run it?", what: ["ls"], action: "shell" as const };

/** A host whose select answers with `pick(labels)`; `seen` collects the labels it offered. */
function host(pick: (labels: string[]) => string | undefined) {
	const seen: string[][] = [];
	const ui = {
		...fakeCtx({ cwd: "." }).ui,
		select: async (_title: string, labels: string[]) => (seen.push(labels), pick(labels)),
		input: async () => undefined,
	};
	return { ctx: { hasUI: true, ui } as unknown as Ctx, seen };
}

describe("a permission answer is decoded by role", () => {
	it("reads each offered choice as the answer its role means", async () => {
		const { ctx, seen } = host((labels) => labels[0]);
		expect(await selectAnswer(ctx, request, "workspace", false, "")).toBe("once");
		expect(seen[0]).toContain(ALLOW_ONCE);
		expect(await selectAnswer(host((labels) => labels.at(-2)).ctx, request, "workspace", false, "")).toBe("deny");
	});

	it("decides nothing for a label no choice carries, however it reads", async () => {
		for (const forged of ["allow once", "Allow", "1. Allow once", " Deny ", "Allow once for this session"]) {
			expect(await selectAnswer(host(() => forged).ctx, request, "workspace", false, "")).toBeUndefined();
		}
		expect(await selectAnswer(host(() => undefined).ctx, request, "workspace", false, "")).toBeUndefined();
	});
});

describe("an external agent's permission request is decoded by role", () => {
	const dialog = (ctx: Ctx, options: { optionId: string; name: string; kind: string }[]) =>
		externalPermissionDialog(ctx as never)(
			{ sessionId: "s", toolCall: { toolCallId: "t", title: "Run it" }, options } as never,
			new AbortController().signal,
		);

	it("selects the option the person picked, whatever the agent named it", async () => {
		// The agent names its refusal "Allow once" and its grant "Deny": only the kinds decide.
		const options = [
			{ optionId: "grant", name: "Deny", kind: "allow_once" },
			{ optionId: "refuse", name: "Allow once", kind: "reject_once" },
		];
		const { ctx, seen } = host((labels) => labels[1]);
		expect(await dialog(ctx, options)).toEqual({ outcome: { outcome: "selected", optionId: "refuse" } });
		expect(seen[0]).toEqual(["Deny", "Allow once"]);
		expect(await dialog(host((labels) => labels[0]).ctx, options)).toEqual({
			outcome: { outcome: "selected", optionId: "grant" },
		});
	});

	it("keeps two options with one name apart, and cancels a label it did not offer", async () => {
		const options = [
			{ optionId: "grant", name: "Proceed", kind: "allow_once" },
			{ optionId: "refuse", name: "Proceed", kind: "reject_once" },
		];
		const { ctx, seen } = host((labels) => labels[1]);
		expect(await dialog(ctx, options)).toEqual({ outcome: { outcome: "selected", optionId: "refuse" } });
		expect(new Set(seen[0]).size).toBe(2);
		expect(await dialog(host(() => "1. Proceed").ctx, options)).toEqual({ outcome: { outcome: "cancelled" } });
	});
});
