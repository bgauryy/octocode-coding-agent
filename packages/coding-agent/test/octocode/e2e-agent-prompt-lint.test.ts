import { beforeAll, expect, it } from "vitest";
import { captureAll, type AgentContext } from "./agent-context/capture.ts";
import { formatFindings, lintPrompt } from "./agent-context/lint.ts";

/** B149: the exact prompt of every agent, captured as `generate:prompts` captures it, must pass the free lint. */
let contexts: AgentContext[] = [];

beforeAll(async () => {
	contexts = await captureAll();
}, 600_000);

it("every agent's final system prompt passes the prompt lint", () => {
	expect(contexts.length).toBeGreaterThan(5);
	const findings = contexts.flatMap((context) => lintPrompt(context, contexts));
	expect(formatFindings(findings)).toBe("");
});
