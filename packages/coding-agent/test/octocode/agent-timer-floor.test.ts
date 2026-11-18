import { afterEach, describe, expect, it } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	delete process.env.OCTOCODE_SUBAGENT;
	delete process.env.OCTOCODE_LEAN;
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
		Object.assign(fake.api.session, { getName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.tools.getAll() as { name: string; companionTools?: readonly string[] }[];
		expect(tools.find((tool) => tool.name === "agent")?.companionTools).toEqual(["wait"]);
		expect(tools.some((tool) => tool.name === "wait")).toBe(true);
	});

	it("declares no companion in a lean child, which gets no delegation rules and has timer only from its own list", async () => {
		process.env.OCTOCODE_SUBAGENT = "1";
		process.env.OCTOCODE_LEAN = "1";
		const fake = fakeHost();
		Object.assign(fake.api.session, { getName: () => undefined });
		await octocode(fake.api);
		const tools = fake.api.tools.getAll() as { name: string; companionTools?: readonly string[] }[];
		expect(tools.some((tool) => tool.name === "agent")).toBe(true);
		expect(tools.find((tool) => tool.name === "agent")?.companionTools).toBeUndefined();
	});
});
