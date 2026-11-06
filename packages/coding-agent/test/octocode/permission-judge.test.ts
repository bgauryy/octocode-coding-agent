import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "../../src/core/features/index.ts";
import {
	decide,
	GATE_STEPS,
	judge,
	type Gate,
	type GateStepBodies,
	type GateStepName,
	PERMISSION_STEPS,
	type PermissionStepBodies,
} from "../../src/octocode/permission/judge.ts";

const event = { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } } as ToolCallEvent;
const ctx = {} as ExtensionContext;

/** Bodies that record the order they ran in, and decide as `verdicts` say. */
function recording(verdicts: Partial<Record<GateStepName, Awaited<ReturnType<Gate>>>> = {}) {
	const ran: string[] = [];
	const priors: Record<string, unknown> = {};
	const bodies = Object.fromEntries(
		GATE_STEPS.map((step) => [
			step.name,
			async (_event: ToolCallEvent, _ctx: ExtensionContext, prior?: { ask?: string }) => {
				ran.push(step.name);
				priors[step.name] = prior?.ask;
				return verdicts[step.name];
			},
		]),
	) as GateStepBodies;
	return { ran, priors, bodies };
}

const audit = () => {
	const audited: string[] = [];
	return {
		audited,
		options: {
			audited:
				(gate: Gate): Gate =>
				async (e, c, p) => {
					const verdict = await gate(e, c, p);
					if (verdict?.block) audited.push(verdict.reason ?? "blocked");
					return verdict;
				},
			invariants: (async () => ({ block: true, reason: "invariant" })) as Gate,
		},
	};
};

describe("permission step tables", () => {
	it("pins the tool_call pipeline order by step name", () => {
		expect(GATE_STEPS.map((step) => step.name)).toEqual([
			"plan-mode",
			"git-state",
			"reservation",
			"metadata",
			"pre-tool-use",
			"plan-recheck",
			"permission",
		]);
	});

	it("pins which steps each entry runs and which are audited by the pipeline", () => {
		expect(GATE_STEPS.filter((step) => step.entries.some((entry) => entry === "hook")).map((s) => s.name)).toEqual([
			"metadata",
			"plan-recheck",
			"permission",
		]);
		expect(GATE_STEPS.filter((step) => step.audited).map((step) => step.name)).toEqual([
			"plan-mode",
			"git-state",
			"reservation",
			"metadata",
			"pre-tool-use",
		]);
	});

	it("pins the permission gate's step order by name", () => {
		expect([...PERMISSION_STEPS]).toEqual([
			"source-projection",
			"role",
			"classify",
			"landing",
			"provenance",
			"reasons",
			"no-effect",
			"source-policy-file",
			"check",
		]);
	});

	it("runs every tool step in table order when none blocks", async () => {
		const { ran, bodies } = recording();
		expect(await judge("tool", bodies, event, ctx, audit().options)).toBeUndefined();
		expect(ran).toEqual(GATE_STEPS.map((step) => step.name));
	});

	it("stops at the first block, audits it when its step is audited, and runs nothing after", async () => {
		const { audited, options } = audit();
		const { ran, bodies } = recording({ reservation: { block: true, reason: "reserved" } });
		expect(await judge("tool", bodies, event, ctx, options)).toEqual({ block: true, reason: "reserved" });
		expect(ran).toEqual(["plan-mode", "git-state", "reservation"]);
		expect(audited).toEqual(["reserved"]);
	});

	it("does not audit the plan recheck or the permission step, which audits its own", async () => {
		for (const name of ["plan-recheck", "permission"] as const) {
			const { audited, options } = audit();
			const { bodies } = recording({ [name]: { block: true, reason: name } });
			expect(await judge("tool", bodies, event, ctx, options)).toEqual({ block: true, reason: name });
			expect(audited).toEqual([]);
		}
	});

	it("skips git-state when no body is supplied", async () => {
		const { ran, bodies } = recording();
		await judge("tool", { ...bodies, "git-state": undefined }, event, ctx, audit().options);
		expect(ran).toEqual(["plan-mode", "reservation", "metadata", "pre-tool-use", "plan-recheck", "permission"]);
	});

	it("runs only metadata, the plan recheck and the permission step for a hook's call", async () => {
		const { ran, bodies } = recording();
		await judge("hook", bodies, event, ctx, audit().options);
		expect(ran).toEqual(["metadata", "plan-recheck", "permission"]);
	});

	it("hands a PreToolUse ask to the later steps and re-runs the invariants for a rewritten call", async () => {
		const { priors, bodies } = recording({ "pre-tool-use": { ask: "hook says ask" } });
		expect(await judge("tool", bodies, event, ctx, audit().options)).toBeUndefined();
		expect(priors["plan-recheck"]).toBe("hook says ask");
		expect(priors.permission).toBe("hook says ask");
		expect(priors["pre-tool-use"]).toBeUndefined();

		const rewritten = audit();
		const second = recording({ "pre-tool-use": { rewritten: true } });
		expect(await judge("tool", second.bodies, event, ctx, rewritten.options)).toEqual({
			block: true,
			reason: "invariant",
		});
		expect(second.ran).toEqual(["plan-mode", "git-state", "reservation", "metadata", "pre-tool-use"]);
		expect(rewritten.audited).toEqual(["invariant"]);
	});

	it("lets the first permission step that decides win, allow included", async () => {
		const ran: string[] = [];
		const bodies = Object.fromEntries(
			PERMISSION_STEPS.map((name) => [
				name,
				() => {
					ran.push(name);
					return name === "no-effect" ? { result: undefined } : undefined;
				},
			]),
		) as unknown as PermissionStepBodies<object>;
		expect(await decide(bodies, {})).toBeUndefined();
		expect(ran).toEqual(["source-projection", "role", "classify", "landing", "provenance", "reasons", "no-effect"]);
	});

	it("fails closed when no permission step decides", async () => {
		const bodies = Object.fromEntries(
			PERMISSION_STEPS.map((name) => [name, () => undefined]),
		) as unknown as PermissionStepBodies<object>;
		await expect(decide(bodies, {})).rejects.toThrow("No permission step decided the call");
	});
});
