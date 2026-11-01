import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalAgents, type ExternalFactories, type ExternalPolicy } from "../../src/octocode/external/manager.ts";
import type { ExternalBackend } from "@octocodeai/octocode-contracts/external";
import type { MessageReader } from "../../src/octocode/shared/references.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const token = `sk-ant-${"a".repeat(40)}`;
const managers: ExternalAgents[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.reset()));
});

/** A store holding message 41 from kelp to lead; anyone else reads "not found". */
const reader: MessageReader = {
	readMessage: (id, requester) =>
		id === 41 && requester === "lead"
			? { id, from: "kelp", text: `Findings: the cache is stale.\nkey=${token}`, at: Date.UTC(2026, 9, 29, 12) }
			: { error: "not found" },
};

async function connected() {
	const cwd = fs.realpathSync(tmp());
	const ctx = fakeCtx({ cwd });
	const backend = {
		cwd,
		sessionId: "peer-session",
		prompt: vi.fn<ExternalBackend["prompt"]>(async () => ({ text: "ok" })),
		cancel: async () => undefined,
		close: async () => undefined,
	} satisfies ExternalBackend;
	const beforeSend = vi.fn<ExternalPolicy["beforeSend"]>(async () => undefined);
	const policy: ExternalPolicy = {
		authorize: async () => undefined,
		beforeSend,
		afterReceive: async () => undefined,
		permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
		sender: () => "lead",
		references: () => ({ requester: "lead", messages: reader, children: () => [] }),
	};
	const factories = { acp: async () => backend, octocode: async () => backend } as unknown as ExternalFactories;
	const manager = new ExternalAgents(policy, factories);
	managers.push(manager);
	await manager.call({ action: "connect", id: "peer", transport: "acp", vendor: "fixture", command: "x", cwd }, ctx);
	const prompt = (refs: string[]) => manager.call({ action: "prompt", id: "peer", text: "Check this.", refs }, ctx);
	return { backend, beforeSend, prompt };
}

describe("external prompt refs through the shared resolver", () => {
	it("sends the referenced message fenced with its original sender, with secrets redacted", async () => {
		const state = await connected();
		await state.prompt(["msg#41"]);
		const sent = state.backend.prompt.mock.calls[0][0];
		expect(sent.startsWith("Check this.\n\n## Referenced content")).toBe(true);
		expect(sent).toContain("msg#41: Message #41 from agent kelp");
		expect(sent).toContain("Findings: the cache is stale.");
		expect(sent).not.toContain(token);
		expect(state.beforeSend.mock.calls[0][0].text).toBe(sent);
	});

	it("refuses a message the requester may not read, and an unknown report, before anything is sent", async () => {
		const state = await connected();
		const error = await state.prompt(["msg#7", "report:ghost"]).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ execution: "not-sent" });
		expect(String(error)).toContain("msg#7: not found");
		expect(String(error)).toContain("report:ghost");
		expect(state.beforeSend).not.toHaveBeenCalled();
		expect(state.backend.prompt).not.toHaveBeenCalled();
	});
});
