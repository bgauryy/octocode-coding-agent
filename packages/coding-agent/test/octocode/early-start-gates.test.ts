import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMcpReadOnlyTools } from "../../src/octocode/permission/mcp-reads.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { PERMISSION_ID } from "../../src/octocode/permission/mode.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { takeTiming } from "../../src/octocode/shared/locks.ts";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
import { tmp } from "./helpers.ts";

/** The `tool_call_early_start` and `tool_call_discarded` handlers of the tool gates, as the session runner fires them. */
describe("early start policy of the tool gates", () => {
	useResearchRoles();
	beforeEach(() => setMcpReadOnlyTools(() => new Set([RESEARCH.readOnly])));
	afterEach(() => setMcpReadOnlyTools(() => new Set()));

	async function setup(
		annotations: ToolGatesOptions["annotations"] = () => undefined,
		mode = "manual",
		checks: { provenance?: () => { why: string } | undefined; ask?: string; hooked?: string } = {},
	) {
		const cwd = fs.realpathSync(tmp());
		fs.writeFileSync(path.join(cwd, "notes.txt"), "one\n");
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd });
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
		permission.start(ctx);
		const localReads: ToolGatesOptions["localReads"] = new Map();
		registerToolGates(fake.api, {
			permission,
			provenance: { check: checks.provenance ?? (() => undefined) },
			collab: { reservationGate: async () => undefined },
			hooks: {
				preToolUse: async () => (checks.ask ? { ask: checks.ask } : undefined),
				hasPreToolUse: (toolName: string) => toolName === checks.hooked,
			},
			sourcePolicy: { refresh: async () => undefined },
			activity: { checking: () => undefined },
			localReads,
			annotations,
		} as unknown as ToolGatesOptions);
		const mayStart = async (toolName: string, input: Record<string, unknown> = {}) => {
			await fake.emit("tool_call", { type: "tool_call", toolCallId: "warm", toolName: "wait", input: {} }, ctx);
			return (await fake.fire("tool_call_early_start", { origin: "model", toolCallId: "e1", toolName, input }, ctx)) as
				| boolean
				| undefined;
		};
		return { fake, ctx, cwd, localReads, mayStart };
	}

	it("starts a read role's MCP call without a hint, and refuses an unhinted tool that no mode asks about", async () => {
		const { mayStart } = await setup();
		expect(await mayStart(RESEARCH.readOnly, {})).toBe(true);
		expect(await mayStart("wait", {})).toBe(false);
	});

	it("refuses an MCP tool without the read role, a shell call and a tool without a verdict of its own", async () => {
		const { mayStart } = await setup();
		expect(await mayStart(RESEARCH.other, {})).toBe(false);
		expect(await mayStart("bash", { command: "ls" })).toBe(false);
		expect(await mayStart("mcp__unknown__tool", {})).toBe(false);
	});

	it("leaves a call a PreToolUse hook matches to its normal time, so the hook runs once and never for a discarded call", async () => {
		const hooked = await setup(undefined, "manual", { hooked: RESEARCH.readOnly });
		expect(await hooked.mayStart(RESEARCH.readOnly, {})).toBe(false);
		const other = await setup(undefined, "manual", { hooked: "bash" });
		expect(await other.mayStart(RESEARCH.readOnly, {})).toBe(true);
	});

	it("starts a declared read-only tool that no mode asks about", async () => {
		const { mayStart } = await setup((name) => (name === "wait" ? { readOnlyHint: true } : undefined));
		expect(await mayStart("wait", {})).toBe(true);
	});

	it("drops a discarded call's local-read snapshot and check timing", async () => {
		const { fake, ctx, localReads } = await setup(undefined, "full");
		const call = { type: "tool_call", toolCallId: "e1", toolName: RESEARCH.reader, input: { path: "notes.txt" } };
		await fake.emit("tool_call", call, ctx);
		expect(localReads.has("e1")).toBe(true);
		expect(takeTiming("e1", Date.now() + 60_000)).toMatchObject({ queuedMs: expect.any(Number) });
		await fake.emit("tool_call_discarded", { toolCallId: "e1" }, ctx);
		expect(localReads.has("e1")).toBe(false);
		expect(takeTiming("e1", Date.now() + 60_000)).toEqual({});
	});

	/** Counts the dialogs a check opens (the default select, or a custom card) and answers "allow once". */
	function watchDialogs(ctx: Awaited<ReturnType<typeof setup>>["ctx"]) {
		const shown: string[] = [];
		const ui = ctx.ui as unknown as Record<string, unknown>;
		ui.select = async (title: string) => {
			shown.push(title);
			return undefined;
		};
		ui.custom = async () => {
			shown.push("custom");
			return undefined;
		};
		return shown;
	}
	const audit = (entries: Array<{ customType: string; data: unknown }>) =>
		entries.filter((entry) => entry.customType === PERMISSION_ID);
	const earlyCall = { type: "tool_call", toolCallId: "e1", origin: "model", early: true, input: {} };

	for (const [reason, checks] of [
		["a provenance hit", { provenance: () => ({ why: "text from an untrusted page" }) }],
		["a PreToolUse hook's ask", { ask: "the hook wants an answer" }],
	] as const) {
		it(`defers an early call that ${reason} would ask about, with no dialog and no audit entry, then asks normally`, async () => {
			const { fake, ctx } = await setup(undefined, "workspace", checks);
			const shown = watchDialogs(ctx);
			// The record is process-wide: drop what an earlier test's call with this id left.
			takeTiming("e1", Date.now());
			const verdict = await fake.fire("tool_call", { ...earlyCall, toolName: RESEARCH.readOnly }, ctx);
			expect(verdict).toEqual({ defer: true });
			expect(shown).toEqual([]);
			expect(audit(fake.entries)).toEqual([]);
			expect(takeTiming("e1", Date.now() + 60_000)).toEqual({});
			// After the message ended the same call is judged without the flag: the dialog may appear then.
			const { early: _early, ...normal } = earlyCall;
			const later = await fake.fire("tool_call", { ...normal, toolName: RESEARCH.readOnly }, ctx);
			expect(shown.length).toBeGreaterThan(0);
			expect(later).toMatchObject({ block: true });
		});
	}

	it("writes an early call's audit entry only when it ends, and none for a discarded one", async () => {
		const { fake, ctx } = await setup(undefined, "full");
		await fake.emit("tool_call", { ...earlyCall, toolName: RESEARCH.readOnly }, ctx);
		await fake.emit("tool_call", { ...earlyCall, toolCallId: "e2", toolName: RESEARCH.readOnly }, ctx);
		expect(audit(fake.entries)).toEqual([]);
		await fake.emit("tool_call_discarded", { toolCallId: "e2" }, ctx);
		await fake.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "e2" }, ctx);
		expect(audit(fake.entries)).toEqual([]);
		await fake.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "e1" }, ctx);
		expect(audit(fake.entries)).toHaveLength(1);
	});
});
