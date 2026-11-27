import { contentText, fauxAssistantMessage, getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { registerPlanning } from "../../src/octocode/plan/register.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { PLAN_REMINDER_TYPE } from "../../src/octocode/plan/prompts.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { setPlanStartup } from "../../src/octocode/plan/startup.ts";
import { readPlan, PLAN_ENTRY } from "../../src/core/plan-state.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { createHarness, getUserTexts, type Harness } from "../suite/harness.ts";
import { testFeatures } from "../helpers/features.ts";

let harness: Harness;
afterEach(() => harness?.cleanup());

it("persists revisions, rejects stale approvals and restores planning on branch navigation", async () => {
	const stop = vi.fn(async () => {});
	harness = await createHarness({
		features: testFeatures([
			{
				owner: "native",
				path: "<inline:octocode>",
				factory: (api) => {
					const commands = new Subcommands();
					registerPlanning(api, commands, stop);
					commands.register(api);
				},
			},
		]),
	});
	expect(await harness.session.controlPlan({ action: "enter" })).toMatchObject({ active: true, revision: 0 });
	expect(stop).toHaveBeenCalledOnce();
	await expect(harness.session.executeBash("echo bypass")).rejects.toThrow("planning");
	harness.setResponses([fauxAssistantMessage("1. Inspect the parser\n2. Fix the boundary\n3. Test it")]);
	await harness.session.prompt("Plan the fix");
	expect(getCurrentSystemMessage(harness.session.messages)?.sections?.planning).toBeTruthy();
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
		features: testFeatures([
			{
				owner: "native",
				path: "<inline:octocode>",
				factory: (api) => {
					const commands = new Subcommands();
					registerPlanning(api, commands, stop);
					commands.register(api);
				},
			},
		]),
	});
	await expect(harness.session.controlPlan({ action: "enter" })).rejects.toThrow("job did not stop");
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(false);
	await harness.session.controlPlan({ action: "enter" });
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
});

it("allows only host-owned reads; read-only annotations and similarly named tools cannot bypass it", () => {
	const definition = (name: string, path = "<inline:octocode>", owner: "native" | "builtin" = "native") =>
		({ name, sourceInfo: { path, owner }, annotations: { readOnlyHint: true } }) as never;
	for (const name of ["web", "askUser", "archive", "skill"])
		expect(planningRefusal({ toolName: name, input: {} }, definition(name))).toBeUndefined();
	// `memory` reads by op; a save, a delete and a call without an op are not reads.
	for (const op of ["search", "get", "list"])
		expect(planningRefusal({ toolName: "memory", input: { op } }, definition("memory"))).toBeUndefined();
	for (const input of [{ op: "set" }, { op: "delete" }, {}])
		expect(planningRefusal({ toolName: "memory", input }, definition("memory"))).toContain("Plan mode blocks");
	for (const name of ["file", "bash", "execute", "agent", "browser", "debug", "mcp__untrusted__reader"])
		expect(planningRefusal({ toolName: name, input: {} }, definition(name))).toContain("Plan mode blocks");
	expect(planningRefusal({ toolName: "web", input: {} }, definition("web", "/project/fake.ts", "builtin"))).toContain(
		"blocks",
	);
	expect(
		planningRefusal(
			{ toolName: "mcp__octocode__localFetch", input: {} },
			definition("mcp__octocode__localFetch", "builtin:mcp", "builtin"),
		),
	).toContain("blocks");
});

it("lets the mcp tool report and restart under the plan gate, not stop a server", () => {
	const manage = { name: "mcp", sourceInfo: { path: "builtin:mcp", owner: "builtin" } } as never;
	const refusal = (intent: unknown) => planningRefusal({ toolName: "mcp", input: { intent } }, manage);
	for (const intent of ["list", "tools", "restart"]) expect(refusal(intent), intent).toBeUndefined();
	for (const intent of ["stop", "future", undefined]) expect(refusal(intent), String(intent)).toContain("blocks");
	// Only the MCP host's own tool, and none of a server's tools by that road.
	expect(
		planningRefusal({ toolName: "mcp", input: { intent: "list" } }, {
			name: "mcp",
			sourceInfo: { path: "/project/fake.ts" },
		} as never),
	).toContain("blocks");
});

it("lets the planner inspect the repository with read-only shell commands and nothing else", async () => {
	await shellParserReady();
	const bash = { name: "bash", sourceInfo: { owner: "native", path: "<inline:octocode>" } } as never;
	const refusal = (input: Record<string, unknown>) =>
		planningRefusal({ toolName: "bash", input }, bash, [], planReadOnly);
	for (const command of [
		"git log --oneline -5",
		"git diff --stat && git status",
		"rg -n planning src | head -20",
		"ls -la packages",
		"env LANG=C git log",
	])
		expect(refusal({ command }), command).toBeUndefined();
	for (const command of [
		"git commit -m x",
		"git branch -D old",
		"git -C elsewhere checkout main",
		"sed -i s/a/b/ file.ts",
		"echo x > file.ts",
		"cat a | tee b",
		"sh -c 'rm -rf x'",
		"node -e 1",
		"yarn vitest run",
		"cat $(rm x)",
		"npm install",
		"",
	])
		expect(refusal({ command }), command).toContain("Plan mode blocks this bash command");
	expect(refusal({ command: "ls", background: true })).toContain("Plan mode blocks");
	expect(refusal({ command: "ls", type: "powershell" })).toContain("Plan mode blocks");
	expect(refusal({})).toContain("Plan mode blocks");
	// Without an injected classifier every shell command stays blocked.
	expect(planningRefusal({ toolName: "bash", input: { command: "ls" } }, bash)).toContain("Plan mode blocks");
	// Only the native bash tool: a same-named tool from elsewhere stays blocked.
	expect(
		planningRefusal(
			{ toolName: "bash", input: { command: "ls" } },
			{ name: "bash", sourceInfo: { path: "/project/fake.ts" } } as never,
			[],
			planReadOnly,
		),
	).toContain("Plan mode blocks");
});

it("gates a native bash call through the host's classifier once it is injected", async () => {
	await shellParserReady();
	const fake = fakeHost();
	const planning = registerPlanning(
		fake.api,
		new Subcommands(),
		vi.fn(async () => {}),
	);
	fake.tools.set("bash", { name: "bash", sourceInfo: { owner: "native", path: "<inline:octocode>" } });
	const ctx = fakeCtx({ cwd: "/repo" });
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => "plan-gate",
			getBranch: () => [
				{ type: "custom", customType: PLAN_ENTRY, data: { version: 1, active: true, revision: 1, text: "p" } },
			],
		},
	});
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const gate = (command: string) => planning.gate({ toolName: "bash", input: { command } });
	expect(gate("git log")).toMatchObject({ block: true });
	planning.readOnlyShell = planReadOnly;
	expect(gate("git log")).toBeUndefined();
	expect(gate("git commit -m x")).toMatchObject({ block: true });
});

it("puts the active plan back after a compaction, once, and only while planning", async () => {
	const fake = fakeHost();
	registerPlanning(
		fake.api,
		new Subcommands(),
		vi.fn(async () => {}),
	);
	let branch: unknown[] = [
		{
			type: "custom",
			customType: PLAN_ENTRY,
			data: { version: 1, active: true, revision: 3, text: "1. Inspect\n2. Fix" },
		},
	];
	const ctx = fakeCtx({ cwd: "/repo" });
	Object.assign(ctx, { sessionManager: { getSessionId: () => "plan-reminder", getBranch: () => branch } });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	await fake.fire("session_compact", { reason: "threshold", compactionEntry: {} }, ctx);
	expect(fake.sent).toHaveLength(1);
	expect(fake.sent[0]).toMatchObject({
		message: { customType: PLAN_REMINDER_TYPE, display: false },
		options: { triggerTurn: false },
	});
	expect(fake.sent[0].message.content).toContain("revision 3");
	expect(fake.sent[0].message.content).toContain("1. Inspect\n2. Fix");
	branch = [
		{
			type: "custom",
			customType: PLAN_ENTRY,
			data: { version: 1, active: true, revision: 1, text: "x".repeat(9_000) },
		},
	];
	await fake.fire("session_start", { reason: "resume" }, ctx);
	await fake.fire("session_compact", { reason: "manual", compactionEntry: {} }, ctx);
	expect(fake.sent[1].message.content).toContain("[…clipped]");
	expect(fake.sent[1].message.content.length).toBeLessThan(8_300);
	branch = [
		{ type: "custom", customType: PLAN_ENTRY, data: { version: 1, active: false, revision: 3, text: "1. Inspect" } },
	];
	await fake.fire("session_start", { reason: "resume" }, ctx);
	await fake.fire("session_compact", { reason: "manual", compactionEntry: {} }, ctx);
	expect(fake.sent).toHaveLength(2);
});

it("fails closed for an unknown persisted planning version", () => {
	expect(
		readPlan([{ type: "custom", customType: PLAN_ENTRY, data: { version: 99, active: false } }] as never).active,
	).toBe(true);
});

it("restores a saved plan before an SDK control without lifecycle bindings", async () => {
	const stop = vi.fn(async () => {});
	harness = await createHarness({
		features: testFeatures([
			{
				owner: "native",
				path: "<inline:octocode>",
				factory: (api) => {
					const commands = new Subcommands();
					registerPlanning(api, commands, stop);
					commands.register(api);
				},
			},
		]),
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
		features: testFeatures([
			{
				owner: "native",
				path: "<inline:octocode>",
				factory: (api) => {
					const commands = new Subcommands();
					registerPlanning(api, commands, async () => {});
					commands.register(api);
					api.commands.register("danger", { handler: invoked });
				},
			},
		]),
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
		features: testFeatures([
			{
				owner: "native",
				path: "<inline:octocode>",
				factory: (api) => {
					const commands = new Subcommands();
					registerPlanning(api, commands, async () => {});
					commands.register(api);
					api.commands.register("danger", { handler: invoked });
				},
			},
		]),
	});
	harness.setResponses([fauxAssistantMessage("Research the command before proposing a change.")]);
	await harness.session.prompt("/plan /danger inspect, do not execute");
	await vi.waitFor(() => expect(readPlan(harness.sessionManager.getBranch()).revision).toBe(1));
	expect(getUserTexts(harness).at(-1)).toBe("/danger inspect, do not execute");
	expect(invoked).not.toHaveBeenCalled();
	expect(readPlan(harness.sessionManager.getBranch()).active).toBe(true);
});

it("starts in planning on the startup event only when --plan was given", async () => {
	const startup = async (reason: "startup" | "resume") => {
		const fake = fakeHost();
		registerPlanning(
			fake.api,
			new Subcommands(),
			vi.fn(async () => {}),
		);
		const appended: unknown[] = [];
		fake.api.session.appendEntry = (_type: string, data: unknown) => void appended.push(data);
		const ctx = fakeCtx({ cwd: "/repo" });
		Object.assign(ctx, { sessionManager: { getSessionId: () => `plan-start-${reason}`, getBranch: () => [] } });
		await fake.fire("session_start", { reason }, ctx);
		return appended;
	};
	try {
		setPlanStartup(true);
		expect(await startup("startup")).toMatchObject([{ active: true }]);
		expect(await startup("resume")).toEqual([]);
		setPlanStartup(false);
		expect(await startup("startup")).toEqual([]);
	} finally {
		setPlanStartup(false);
	}
});
