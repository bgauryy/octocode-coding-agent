import { beforeAll, expect, it } from "vitest";
import { captureAll, type AgentContext } from "./agent-context/capture.ts";
import { formatFindings, lintPrompt } from "./agent-context/lint.ts";

/** Capture every agent prompt and check rendering and tool availability. */
let contexts: AgentContext[] = [];

beforeAll(async () => {
	contexts = await captureAll();
}, 600_000);

it("every agent's final system prompt renders and names available tools", () => {
	expect(contexts.length).toBeGreaterThan(5);
	const findings = contexts
		.flatMap((context) => lintPrompt(context, contexts))
		.filter((finding) => finding.rule !== "duplicate-sentence");
	expect(formatFindings(findings)).toBe("");
});
