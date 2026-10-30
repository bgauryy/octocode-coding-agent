import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalAgents, type ExternalFactories, type ExternalPolicy } from "../../src/octocode/external/manager.ts";
import type { ExternalBackend } from "../../src/octocode/external/protocol.ts";
import { registerExternal } from "../../src/octocode/external/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import type * as ReferenceResolver from "../../src/octocode/shared/references.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

// Owner B's resolver is stubbed: these tests pin how the external prompt uses it, not how references resolve.
const resolver = vi.hoisted(() => ({
	resolveReferences: vi.fn(),
	referencedContentBlock: vi.fn(),
	referenceContext: vi.fn(),
}));
vi.mock("../../src/octocode/shared/references.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ReferenceResolver>()),
	...resolver,
}));

const managers: ExternalAgents[] = [];
beforeEach(() => vi.stubEnv("OCTOCODE_HOME", tmp()));
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.reset()));
	vi.restoreAllMocks();
	for (const mock of Object.values(resolver)) mock.mockReset();
});

async function connected(withReferences = true) {
	const cwd = fs.realpathSync(tmp());
	const ctx = fakeCtx({ cwd });
	const backend = {
		cwd,
		sessionId: "peer-session",
		prompt: vi.fn<ExternalBackend["prompt"]>(async () => ({ text: "done", stopReason: "end_turn" })),
		cancel: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	} satisfies ExternalBackend;
	const context = { requester: "lead", children: () => [] };
	const policy = {
		authorize: vi.fn<ExternalPolicy["authorize"]>(async () => undefined),
		beforeSend: vi.fn<ExternalPolicy["beforeSend"]>(async () => undefined),
		afterReceive: vi.fn<ExternalPolicy["afterReceive"]>(async () => undefined),
		permission: () => async () => ({ outcome: { outcome: "cancelled" as const } }),
		sender: () => "lead",
		...(withReferences ? { references: vi.fn(() => context) } : {}),
	} as ExternalPolicy;
	const factories = { acp: async () => backend, octocode: async () => backend } as unknown as ExternalFactories;
	const manager = new ExternalAgents(policy, factories);
	managers.push(manager);
	await manager.call({ action: "connect", id: "peer", transport: "acp", vendor: "fixture", command: "x", cwd }, ctx);
	const prompt = (input: Record<string, unknown>) => manager.call({ action: "prompt", id: "peer", ...input }, ctx);
	return { ctx, backend, policy, context, manager, prompt };
}

describe("external prompt refs", () => {
	it("expands refs before the send hook and the permission dialog, so both see the text the peer gets", async () => {
		const state = await connected();
		const resolved = [{ ref: "msg#4", producer: "kelp", sha: "abc", text: "fenced report" }];
		resolver.resolveReferences.mockResolvedValue({ resolved, errors: [] });
		resolver.referencedContentBlock.mockReturnValue("## Referenced content\nfenced report");
		await state.prompt({ text: "Review this.", refs: ["msg#4", "report:kelp", "msg#4"] });
		const expanded = "Review this.\n\n## Referenced content\nfenced report";
		// Passed as given: `resolveReferences` expands each reference once (references.test.ts).
		expect(resolver.resolveReferences).toHaveBeenCalledWith(["msg#4", "report:kelp", "msg#4"], {
			...state.context,
			artifactAccess: "none",
		});
		expect(resolver.referencedContentBlock).toHaveBeenCalledWith(resolved);
		expect(state.policy.beforeSend).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "outbound", text: expanded }),
			state.ctx,
			expect.anything(),
		);
		expect(state.policy.authorize).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "prompt", text: expanded }),
			state.ctx,
			expect.anything(),
		);
		expect(state.backend.prompt).toHaveBeenCalledWith(expanded, expect.anything());
		const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder.at(-1)!;
		expect(order(resolver.resolveReferences)).toBeLessThan(order(vi.mocked(state.policy.beforeSend)));
		expect(order(vi.mocked(state.policy.beforeSend))).toBeLessThan(order(vi.mocked(state.policy.authorize)));
	});

	it("fails before hooks, permission or the peer when a ref does not resolve, naming each one", async () => {
		const state = await connected();
		vi.mocked(state.policy.authorize).mockClear();
		resolver.resolveReferences.mockResolvedValue({
			resolved: [],
			errors: ["msg#9: not found", "report:ghost: no such subagent"],
		});
		const error = await state.prompt({ text: "x", refs: ["msg#9", "report:ghost"] }).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ execution: "not-sent" });
		expect(String(error)).toContain("msg#9: not found");
		expect(String(error)).toContain("report:ghost: no such subagent");
		expect(state.policy.beforeSend).not.toHaveBeenCalled();
		expect(state.policy.authorize).not.toHaveBeenCalled();
		expect(state.backend.prompt).not.toHaveBeenCalled();
		// The connection is free again for a corrected prompt.
		await expect(state.prompt({ text: "plain" })).resolves.toMatchObject({ busy: false });
	});

	it("refuses refs not-sent when the session supplies no reference context", async () => {
		const state = await connected(false);
		await expect(state.prompt({ text: "x", refs: ["msg#1"] })).rejects.toMatchObject({ execution: "not-sent" });
		expect(resolver.resolveReferences).not.toHaveBeenCalled();
		expect(state.backend.prompt).not.toHaveBeenCalled();
	});

	it("sends plain text untouched without refs and validates the refs field", async () => {
		const state = await connected();
		await state.prompt({ text: "plain" });
		expect(resolver.resolveReferences).not.toHaveBeenCalled();
		expect(state.backend.prompt).toHaveBeenCalledWith("plain", expect.anything());
		await expect(state.prompt({ text: "x", refs: [" "] })).rejects.toThrow("non-empty");
		await expect(state.prompt({ text: "x", refs: Array.from({ length: 17 }, (_, i) => `msg#${i}`) })).rejects.toThrow(
			"at most 16 references",
		);
		await expect(state.manager.call({ action: "cancel", id: "peer", refs: ["msg#1"] }, state.ctx)).rejects.toThrow(
			"does not accept: refs",
		);
	});
});

describe("external reply model view", () => {
	const policy = {
		authorize: async () => undefined,
		beforeSend: async () => undefined,
		afterReceive: async () => undefined,
		permission: () => async () => ({ outcome: { outcome: "cancelled" as const } }),
		sender: () => "lead",
	};
	const savedFile = (text: string) => {
		const match = /"updatesSaved": "(\d+) updates? at (.+?) \(sha256 [0-9a-f]+, \d+ bytes\)"/.exec(text);
		expect(match, text).not.toBeNull();
		const file = match![2].startsWith("~") ? path.join(os.homedir(), match![2].slice(1)) : path.resolve(match![2]);
		return { count: Number(match![1]), lines: fs.readFileSync(file, "utf8").trim().split("\n") };
	};
	const run = async (input: Record<string, unknown>) => {
		const fake = fakeHost();
		registerExternal(fake.api, new Subcommands(), policy);
		return fake.tools.get("externalAgent")!.execute("tool", input, undefined, undefined, fakeCtx({ cwd: tmp() }));
	};

	it("gives the model the reply text, ids and a saved-updates path, and keeps the full updates in details", async () => {
		const updates = [
			{ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } },
			{ sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", rawOutput: "TOOL-SNAPSHOT" } },
		];
		const data = {
			id: "peer",
			messageId: "m-1",
			reply: { text: "ANSWER", stopReason: "end_turn", remoteMessageId: "remote-7", updates },
		};
		vi.spyOn(ExternalAgents.prototype, "call").mockResolvedValue(data);
		const result = await run({ action: "prompt", id: "peer", text: "go" });
		const text = (result.content[0] as { text: string }).text;
		expect(text.match(/ANSWER/g)).toHaveLength(1);
		expect(text).not.toContain("TOOL-SNAPSHOT");
		expect(text).toContain('"messageId": "m-1"');
		expect(text).toContain('"remoteMessageId": "remote-7"');
		expect(text).toContain('"stopReason": "end_turn"');
		const saved = savedFile(text);
		expect(saved.count).toBe(2);
		expect(saved.lines.map((line) => JSON.parse(line))).toEqual(updates);
		expect(result.details).toEqual(data);
	});

	it("treats a failure's partial reply the same way and leaves replies without updates alone", async () => {
		const partial = { text: "half", updates: [{ update: { sessionUpdate: "plan", entries: ["PLAN-ENTRY"] } }] };
		vi.spyOn(ExternalAgents.prototype, "call").mockRejectedValueOnce(
			Object.assign(new Error("timed out"), { execution: "uncertain", partial }),
		);
		const failed = await run({ action: "prompt", id: "peer", text: "go" });
		const failedText = (failed.content[0] as { text: string }).text;
		expect(failed.isError).toBe(true);
		expect(failedText).not.toContain("PLAN-ENTRY");
		expect(failedText).toContain('"execution": "uncertain"');
		expect(savedFile(failedText).count).toBe(1);
		expect(failed.details).toMatchObject({ partial });

		vi.spyOn(ExternalAgents.prototype, "call").mockResolvedValueOnce({ reply: { text: "plain", updates: [] } });
		const plain = await run({ action: "prompt", id: "peer", text: "go" });
		const plainText = (plain.content[0] as { text: string }).text;
		expect(plainText).toContain('"text": "plain"');
		expect(plainText).not.toContain("updates");
	});
});
