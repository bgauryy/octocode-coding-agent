import { afterEach, describe, expect, it } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	delete process.env.OCTOCODE_SUBAGENT;
});

/**
 * The delegation policy's waiting rules (never sleep or poll; wait on a child or item with a timer) need `timer`. The
 * agent tool lists it as a companion, so the loadout keeps timer active whenever agent is, whatever `--tools`,
 * `defaultTools` or `/tools` say; only the operator's `--exclude-tools` removes it (`core/agent-session/tool-loadout.ts`).
 */
describe("agent keeps timer", () => {
	it("declares timer as the agent tool's companion in a delegating session", async () => {
		delete process.env.OCTOCODE_SUBAGENT;
		const fake = fakeHost();
		Object.assign(fake.api, { getSessionName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.getAllTools() as { name: string; companionTools?: readonly string[] }[];
		expect(tools.find((tool) => tool.name === "agent")?.companionTools).toEqual(["timer"]);
		expect(tools.some((tool) => tool.name === "timer")).toBe(true);
	});
});
