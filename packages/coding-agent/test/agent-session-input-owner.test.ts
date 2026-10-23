import { Agent, type InputBatch } from "@octocodeai/octocode-agent-core";
import { expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../src/core/agent-session.ts";

it("rejects a conflicting input owner before accessing session resources", () => {
	const prepareInput = vi.fn(async (batch: InputBatch) => ({ messages: batch.messages }));
	const agent = new Agent({ streamFn: () => { throw new Error("not sampled"); }, prepareInput });
	const resources = vi.fn(() => { throw new Error("resources must not be touched"); });
	const config = { agent, get resourceLoader() { return resources(); } } as unknown as AgentSessionConfig;
	expect(() => new AgentSession(config)).toThrow("AgentSession owns Agent.prepareInput; use a user_input extension instead");
	expect(resources).not.toHaveBeenCalled();
	expect(prepareInput).not.toHaveBeenCalled();
	expect(agent.prepareInput).toBe(prepareInput);
});
