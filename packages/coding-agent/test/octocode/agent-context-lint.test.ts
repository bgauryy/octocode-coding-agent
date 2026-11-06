import { describe, expect, it } from "vitest";
import type { AgentContext } from "./agent-context/capture.ts";
import { lintPrompt } from "./agent-context/lint.ts";

const tool = (name: string) => ({ name, description: "", parameters: { type: "object" } });
const agent = (name: string, text: string, tools: string[]): AgentContext => ({
	name,
	kind: "child",
	sections: [{ name: "rules", text }],
	tools: tools.map(tool),
	messages: [],
});
const rules = (context: AgentContext, all: AgentContext[]) => lintPrompt(context, all).map((f) => f.rule);

describe("lintPrompt", () => {
	const sentence = "Run the focused test before you report, and say which check you could not run.";
	const full = agent("full", "Use `file` and `bash`.", ["bash", "file"]);

	it("accepts a clean prompt", () => {
		expect(lintPrompt(full, [full])).toEqual([]);
	});

	it("flags an unrendered template marker", () => {
		expect(rules(agent("a", "Hello {{name}}", ["bash"]), [])).toEqual(["unrendered-marker"]);
		expect(rules(agent("a", "Hello }}", ["bash"]), [])).toEqual(["unrendered-marker"]);
	});

	it("flags a backticked tool that only another agent declares", () => {
		const limited = agent("limited", "Lock with `agent` first, then `bash`.", ["bash"]);
		const other = agent("other", "", ["bash", "agent"]);
		const findings = lintPrompt(limited, [limited, other]);
		expect(findings.map((f) => f.rule)).toEqual(["foreign-tool"]);
		expect(findings[0]?.detail).toContain("`agent`");
		// Plain words and tools nobody declares are not tool names.
		expect(rules(agent("l", "the agent works; `nothing` here", ["bash"]), [limited, other])).toEqual([]);
	});

	it("flags a sentence of 60+ characters that appears twice, but not a short one", () => {
		expect(rules(agent("d", `${sentence}\nOther.\n- ${sentence}`, ["bash"]), [])).toEqual(["duplicate-sentence"]);
		expect(rules(agent("d", "Be brief and exact.\nBe brief and exact.", ["bash"]), [])).toEqual([]);
	});
});
