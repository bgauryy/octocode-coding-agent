import { contentText, fauxAssistantMessage, getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { registerPlanning } from "../../src/octocode/plan/register.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { readPlan, PLAN_ENTRY } from "../../src/octocode/plan/state.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { NATIVE_FEATURE_PATH } from "../../src/core/native-tools.ts";
import { createHarness, getUserTexts, type Harness } from "../suite/harness.ts";

let harness: Harness;
afterEach(() => harness?.cleanup());

it("persists revisions, rejects stale approvals and restores planning on branch navigation", async () => {
	const stop = vi.fn(async () => {});
	harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					const commands = new Subcommands();
					registerPlanning(pi, commands, stop);
					commands.register(pi);
				},
			},
		],
	});
	expect(await harness.session.controlPlan({ action: "enter" })).toMatchObject({ active: true, revision: 0 });
	expect(stop).toHaveBeenCalledOnce();
	await expect(harness.session.executeBash("echo bypass")).rejects.toThrow("planning");
	harness.setResponses([fauxAssistantMessage("1. Inspect the parser\n2. Fix the boundary\n3. Test it")]);
	await harness.session.prompt("Plan the fix");
	expect(getCurrentSystemMessage(harness.session.messages)?.sections?.planning).toContain("verification of success");
	const plan = await harness.session.controlPlan({ action: "show" });
	expect(plan).toMatchObject({ active: true, revision: 1 });
	const planEntry = harness.sessionManager.getLeafId()!;
	await expect(harness.session.controlPlan({ action: "approve", revision: 2 })).rejects.toThrow("revision changed");
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
	await harness.session.controlPlan({ action: "leave" });
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(false);
	await harness.session.navigateTree(planEntry);
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
	await expect(harness.session.executeBash("echo still blocked")).rejects.toThrow("planning");
	harness.setResponses([fauxAssistantMessage("Approved implementation completed")]);
	expect(await harness.session.controlPlan({ action: "approve", revision: 1 })).toMatchObject({
		active: false,
		revision: 1,
	});
	await vi.waitFor(() => {
		expect(harness.session.isIdle).toBe(true);
		expect(JSON.stringify(harness.session.messages)).toContain("Approved implementation completed");
	});
	expect(readPlan(harness.sessionManager.getBranch())).toMatchObject({ active: false, revision: 1 });
	expect(getCurrentSystemMessage(harness.session.messages)?.sections?.planning).toBeUndefined();
});

it("does not announce planning if stopping work fails, and can retry", async () => {
	const stop = vi.fn().mockRejectedValueOnce(new Error("job did not stop")).mockResolvedValue(undefined);
	harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					const commands = new Subcommands();
					registerPlanning(pi, commands, stop);
					commands.register(pi);
				},
			},
		],
	});
	await expect(harness.session.controlPlan({ action: "enter" })).rejects.toThrow("job did not stop");
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(false);
	await harness.session.controlPlan({ action: "enter" });
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
});

it("allows only host-owned reads; read-only annotations and similarly named tools cannot bypass it", () => {
	const definition = (name: string, path = NATIVE_FEATURE_PATH) =>
		({ name, sourceInfo: { path }, annotations: { readOnlyHint: true } }) as never;
	for (const name of ["web", "askUser", "archive", "skill"])
		expect(planningRefusal({ toolName: name, input: {} }, definition(name))).toBeUndefined();
	for (const name of ["file", "bash", "execute", "agent", "browser", "debug", "mcp__untrusted__reader"])
		expect(planningRefusal({ toolName: name, input: {} }, definition(name))).toContain("Plan mode blocks");
	expect(planningRefusal({ toolName: "web", input: {} }, definition("web", "/project/fake.ts"))).toContain("blocks");
	expect(
		planningRefusal(
			{ toolName: "mcp__octocode__localFetch", input: {} },
			definition("mcp__octocode__localFetch", "builtin:mcp"),
		),
	).toContain("blocks");
});

it("fails closed for an unknown persisted planning version", () => {
	expect(
		readPlan([{ type: "custom", customType: PLAN_ENTRY, data: { version: 99, active: false } }] as never).active,
	).toBe(true);
});

it("restores a saved plan before an SDK control without lifecycle bindings", async () => {
	const stop = vi.fn(async () => {});
	harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					const commands = new Subcommands();
					registerPlanning(pi, commands, stop);
					commands.register(pi);
				},
			},
		],
	});
	harness.sessionManager.appendCustomEntry(PLAN_ENTRY, { version: 1, active: true, revision: 7, text: "Saved plan" });
	expect(await harness.session.controlPlan({ action: "enter" })).toEqual({
		active: true,
		revision: 7,
		text: "Saved plan",
	});
	expect(stop).not.toHaveBeenCalled();
	harness.setResponses([fauxAssistantMessage("Revised plan")]);
	await harness.session.prompt("Refine it");
	expect(readPlan(harness.sessionManager.getBranch())).toEqual({ active: true, revision: 8, text: "Revised plan" });
});

it("approves the exact saved plan even when its original assistant message is absent", async () => {
	const invoked = vi.fn();
	harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					const commands = new Subcommands();
					registerPlanning(pi, commands, async () => {});
					commands.register(pi);
					pi.registerCommand("danger", { handler: invoked });
				},
			},
		],
	});
	const saved = '/danger\nUpdate only the parser. Verify escaped "quotes" and boundary cases.';
	harness.sessionManager.appendCustomEntry(PLAN_ENTRY, { version: 1, active: true, revision: 3, text: saved });
	harness.setResponses([fauxAssistantMessage("Implementation result")]);
	await harness.session.controlPlan({ action: "approve", revision: 3 });
	await vi.waitFor(() =>
		expect(
			harness.session.messages.some(
				(m) => m.role === "assistant" && contentText(m.content) === "Implementation result",
			),
		).toBe(true),
	);
	const request = getUserTexts(harness).at(-1)!;
	expect(JSON.parse(request.slice(request.indexOf('{"revision"')))).toEqual({ revision: 3, plan: saved });
	expect(invoked).not.toHaveBeenCalled();
});

it("treats a slash-prefixed planning task as literal user text rather than executing another command", async () => {
	const invoked = vi.fn();
	harness = await createHarness({
		extensionFactories: [
			{
				path: NATIVE_FEATURE_PATH,
				factory: (pi) => {
					const commands = new Subcommands();
					registerPlanning(pi, commands, async () => {});
					commands.register(pi);
					pi.registerCommand("danger", { handler: invoked });
				},
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("Research the command before proposing a change.")]);
	await harness.session.prompt("/plan /danger inspect, do not execute");
	await vi.waitFor(() => expect(readPlan(harness.sessionManager.getBranch()).revision).toBe(1));
	expect(getUserTexts(harness).at(-1)).toBe("/danger inspect, do not execute");
	expect(invoked).not.toHaveBeenCalled();
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
});
