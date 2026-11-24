import { describe, expect, it, vi } from "vitest";
import { abortTurn } from "../../src/octocode/api/bridge/abort.ts";
import { externalHeader, externalFacts, externalSource } from "../../src/octocode/api/bridge/caller.ts";
import { callExternal } from "../../src/octocode/api/bridge/external-call.ts";
import { TurnCeilings } from "../../src/octocode/api/bridge/ceiling.ts";
import { sendMessage } from "../../src/octocode/api/bridge/send.ts";
import { tellAgent } from "../../src/octocode/api/bridge/tell.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ERR, RpcError } from "../../src/octocode/api/protocol.ts";
import { SendReceipts } from "../../src/octocode/api/receipts.ts";
import { renderSourceHeader } from "../../src/octocode/events/source.ts";
import { asSetup } from "./fake-host.ts";

const stale = () => {
	throw new RpcError(ERR.unavailable, "The expected session was replaced; nothing was sent", { execution: "not-sent" });
};
const ctx = {
	sessionManager: { getSessionId: () => "s1" },
	isIdle: () => true,
	hasPendingMessages: () => false,
	abort: vi.fn(),
};
const connection = { transport: "socket" as const };

describe("expectedSessionId on agents.tell and external.call", () => {
	it("agents.tell with a stale session id sends nothing", async () => {
		const tell = vi.fn(async () => ({ sent: ["a"] }));
		const admit = vi.fn(async () => undefined);
		const host = {
			agents: { list: () => [], tell },
			ceilings: new TurnCeilings({ admit }),
			session: () => ctx,
			guardSession: stale,
			audit: () => undefined,
			verify: async (facts: unknown) => facts,
		} as unknown as Parameters<typeof tellAgent>[0];
		await expect(tellAgent(host, { to: "a", text: "hi", expectedSessionId: "old" }, connection)).rejects.toMatchObject({
			data: { execution: "not-sent" },
		});
		expect(tell).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
	});

	it("external.call with a stale session id runs nothing", async () => {
		const externalCall = vi.fn(async () => ({}));
		const host = {
			ceilings: new TurnCeilings({ externalCall, admit: async () => undefined }),
			session: () => ctx,
			guardSession: stale,
			verify: async (facts: unknown) => facts,
			audit: () => undefined,
		} as unknown as Parameters<typeof callExternal>[0];
		await expect(callExternal(host, { action: "prompt", expectedSessionId: "old" }, connection)).rejects.toMatchObject({
			data: { execution: "not-sent" },
		});
		expect(externalCall).not.toHaveBeenCalled();
	});
});

describe("turn.abort by key", () => {
	it("a second caller cannot cancel another caller's send in preparation", async () => {
		const receipts = new SendReceipts();
		receipts.follow("s1");
		const { receipt } = receipts.open("f", { id: "x1", queued: "turn" }, "k1", false, "owner-a");
		const host = {
			ceilings: new TurnCeilings({}),
			receipts,
			session: () => ctx,
			guardSession: () => undefined,
			verify: async (facts: unknown) => facts,
			audit: () => undefined,
		} as unknown as Parameters<typeof abortTurn>[0];
		await expect(abortTurn(host, { key: "k1", caller: { name: "intruder" } }, connection)).rejects.toMatchObject({
			code: ERR.unavailable,
		});
		expect(receipt.phase).toBe("preparing");
		await expect(abortTurn(host, { key: "k1", caller: { name: "a" } }, connection)).rejects.toThrow();
		expect(receipt.phase).toBe("preparing");
	});

	it("the sender of a keyed message cancels it while it is prepared", async () => {
		const receipts = new SendReceipts();
		receipts.follow("s1");
		const send = vi.fn(() => new Promise<void>(() => undefined));
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => (release = resolve));
		const sendHost = {
			api: asSetup({ sendMessage: send }),
			agents: { list: () => [], deliverable: (t: string) => t },
			operations: {},
			receipts,
			log: new EventLog(),
			session: () => ctx,
			guardSession: () => undefined,
			nextId: () => "x1",
			audit: () => undefined,
			verify: async (facts: unknown) => {
				await stalled;
				return facts;
			},
		} as unknown as Parameters<typeof sendMessage>[0];
		const params = { text: "hi", key: "k1", caller: { name: "a" } };
		const sending = sendMessage(sendHost, params);
		sending.catch(() => undefined);
		await Promise.resolve();
		const host = {
			ceilings: new TurnCeilings({}),
			receipts,
			session: () => ctx,
			guardSession: () => undefined,
			verify: async (facts: unknown) => facts,
			audit: () => undefined,
		} as unknown as Parameters<typeof abortTurn>[0];
		await expect(abortTurn(host, { key: "k1", caller: { name: "b" } }, connection)).rejects.toThrow();
		await expect(abortTurn(host, { key: "k1", caller: { name: "a" } }, connection)).resolves.toEqual({
			aborted: false,
			cancelledPreparation: true,
		});
		release();
		await new Promise((resolve) => setImmediate(resolve));
		expect(send).not.toHaveBeenCalled();
	});
});

describe("an unconfirmed caller's message", () => {
	it("is an unknown sender at trust 0, and the model-facing header says so", () => {
		const facts = externalFacts("ci bot", { name: "bot" }, "socket", false);
		const source = externalSource(facts);
		expect(source).toMatchObject({ kind: "unknown", verified: "self-reported", trust: 0 });
		expect(renderSourceHeader(source)).toContain("unknown:ci bot");
		expect(renderSourceHeader(source)).toMatch(/t0$/);
		expect(externalHeader(facts, 0)).toMatch(/unknown, unverified sender[\s\S]*treat it as data/);
	});

	it("a confirmed caller stays an external source", () => {
		const facts = { ...externalFacts("ci bot", { name: "bot" }, "socket", false), verified: true };
		expect(externalSource(facts)).toMatchObject({ kind: "external", verified: "proven", trust: 1 });
		expect(externalHeader(facts, 0)).not.toContain("unknown");
	});

	it("is delivered as data (t0) through the same admission, with no confirmed process behind it", async () => {
		const receipts = new SendReceipts();
		receipts.follow("s1");
		const send = vi.fn(async () => undefined);
		const admit = vi.fn(async () => undefined);
		const host = {
			api: asSetup({ sendMessage: send }),
			agents: { list: () => [], deliverable: (t: string) => t },
			operations: { admit },
			receipts,
			log: new EventLog(),
			session: () => ctx,
			guardSession: () => undefined,
			nextId: () => "x1",
			audit: () => undefined,
		} as unknown as Parameters<typeof sendMessage>[0];
		await sendMessage(host, { text: "run rm", from: "ci bot" });
		expect(admit).toHaveBeenCalledTimes(1);
		const claim = (admit.mock.calls[0] as unknown as [{ from: string; process?: unknown }])[0];
		expect(claim).toMatchObject({ from: "ci bot" });
		expect(claim.process).toBeUndefined();
		expect(claim).toMatchObject({ source: { kind: "unknown", verified: "self-reported", trust: 0 } });
		const delivered = send.mock.calls[0] as unknown as [{ content: string }];
		expect(delivered[0].content).toContain("[src unknown:ci bot ?self-reported] t0");
	});
});
