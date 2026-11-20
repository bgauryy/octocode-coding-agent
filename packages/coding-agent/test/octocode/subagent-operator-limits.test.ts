import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { OPERATOR_EXCLUDE_TOOLS_ENV, OPERATOR_NO_MCP_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { operatorLimits, recordOperatorLimits } from "../../src/octocode/subagents/process/operator-limits.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";

const SESSION = { dir: "/tmp/session", id: "child" };
const excluded = (args: string[]) => parseArgs(args).excludeTools ?? [];

afterEach(() => {
	delete process.env[OPERATOR_EXCLUDE_TOOLS_ENV];
	delete process.env[OPERATOR_NO_MCP_ENV];
});

describe("an operator's flags in a child's arguments", () => {
	it("adds nothing without them", () => {
		const args = buildAgentArgs(undefined, undefined, SESSION);
		expect(args).not.toContain("--no-mcp");
		expect(excluded(args)).toEqual(["mcp__browser__*", "mcp__desktop__*", "mcp__freellama__*"]);
	});

	it("carries --exclude-tools and --no-mcp, including what a profile may not remove", () => {
		recordOperatorLimits({ excludeTools: ["bash", "file", "mcp__github__*"], noMcp: true });
		const args = buildAgentArgs(undefined, undefined, SESSION);
		expect(args).toContain("--no-mcp");
		expect(excluded(args)).toEqual([
			"bash",
			"file",
			"mcp__github__*",
			"mcp__browser__*",
			"mcp__desktop__*",
			"mcp__freellama__*",
		]);
	});

	it("keeps a profile's own excludes beside them", () => {
		recordOperatorLimits({ excludeTools: ["bash"] });
		const args = buildAgentArgs({ name: "p", excludeTools: "web" } as never, undefined, SESSION);
		expect(excluded(args)).toEqual(["bash", "web", "mcp__browser__*", "mcp__desktop__*", "mcp__freellama__*"]);
		expect(args).not.toContain("--no-mcp");
	});
});

describe("the local-model server in a child's arguments", () => {
	const profile = (tools: string) => ({ name: "p", tools }) as never;

	it("stays with the main session: a child excludes it", () => {
		expect(excluded(buildAgentArgs(undefined, undefined, SESSION))).toContain("mcp__freellama__*");
	});

	it("is kept by a profile that names it", () => {
		const args = buildAgentArgs(profile("mcp__freellama__*"), undefined, SESSION);
		expect(excluded(args)).not.toContain("mcp__freellama__*");
	});

	it("is kept when the task names the server", () => {
		const args = buildAgentArgs(undefined, undefined, SESSION, [], undefined, ["freellama"]);
		expect(excluded(args)).not.toContain("mcp__freellama__*");
	});

	it("is not selected by a broad mcp__* entry", () => {
		expect(excluded(buildAgentArgs(profile("mcp__*"), undefined, SESSION))).toContain("mcp__freellama__*");
	});
});

describe("recording them", () => {
	it("records nothing in a subagent: its flags include what its profile took away", () => {
		const env: NodeJS.ProcessEnv = { [SUBAGENT_ENV]: "1", [OPERATOR_EXCLUDE_TOOLS_ENV]: "bash" };
		recordOperatorLimits({ excludeTools: ["bash", "web"], noMcp: true }, env);
		expect(operatorLimits(env)).toEqual({ excludeTools: ["bash"], noMcp: false });
	});

	it("adds to what a session a child's shell started inherited", () => {
		const env: NodeJS.ProcessEnv = { [OPERATOR_EXCLUDE_TOOLS_ENV]: "bash", [OPERATOR_NO_MCP_ENV]: "1" };
		recordOperatorLimits({ excludeTools: ["web", "bash"] }, env);
		expect(operatorLimits(env)).toEqual({ excludeTools: ["bash", "web"], noMcp: true });
	});
});
