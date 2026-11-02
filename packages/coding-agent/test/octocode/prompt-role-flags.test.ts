import { readFileSync } from "node:fs";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_ONLY_ENV } from "../../../common/src/env.ts";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { identityBlock, withIdentity } from "../../src/octocode/instructions/task.ts";
import { AGENT_ROLE_ENV } from "../../src/octocode/team/store/env.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections, tmp } from "./helpers.ts";

const BROWSER_RULE =
	"Use the browser tools to interact with your own isolated browser as far as the task requires, within the task and the user's authorization; call other MCP tools only when they cannot change files or external state.";
const MCP_RULE =
	"Call only MCP tools that cannot change files or external state; the permission layer does not check other servers' tools for you.";
const BACKGROUND = "You run in the background: your parent can answer a message while you work.";
const FOREGROUND =
	"You run in the foreground: your parent reads your messages only with your report, so put a decision or approval you need in a `blocked` report; do not wait for an answer.";

const profile = (name: string, permissions: string[] = []) =>
	[name, { name, description: name, readOnly: true, permissions } as never] as const;
const PROFILES = new Map([profile("browser", ["browser.control"]), profile("researcher"), profile("inspector")]);

/** The sections a session prepares for its first request, after the given MCP status. */
async function sections(
	options: { isSubagent: boolean; role?: string; readOnly?: boolean },
	selectedTools: string[],
	status: Parameters<typeof setMcpSessionStatus>[1],
): Promise<Record<string, string>> {
	if (options.role) vi.stubEnv(AGENT_ROLE_ENV, options.role);
	if (options.readOnly) vi.stubEnv(READ_ONLY_ENV, "1");
	const fake = fakeHost();
	for (const name of selectedTools) fake.tools.set(name, { name, exposure: "direct" });
	fake.api.events = createEventBus();
	setMcpSessionStatus(fake.api.events, status);
	registerTurnSetup(fake.api, { isSubagent: options.isSubagent, profiles: () => PROFILES });
	const event = {
		systemPromptOptions: {
			sections: {} as Record<string, string>,
			baseSections: {} as Record<string, string>,
			selectedTools,
		},
	};
	await fake.emit("before_agent_start", event, {});
	return allSections(event);
}

const server = (name: string, state: string, enabled = true) => ({
	name,
	enabled,
	state,
	toolCount: 0,
	source: "default",
	exposure: "direct" as const,
});

describe("policy flags each agent derives from its profile and servers", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	it("lets the browser child drive its own browser and gives other read-only children the honest MCP rule", async () => {
		const browserTools = ["file", "mcp", "mcp__browser__open", "mcp__browser__click"];
		const browser = await sections({ isSubagent: true, role: "browser", readOnly: true }, browserTools, [
			server("browser", "connecting"),
		]);
		expect(browser.octocode_work).toContain(BROWSER_RULE);
		expect(browser.octocode_work).not.toContain(MCP_RULE);
		expect(browser.octocode_work).not.toContain("Call only read-only MCP tools");
		// Fixed by the profile: the same text once the server has connected.
		const connected = await sections({ isSubagent: true, role: "browser", readOnly: true }, browserTools, [
			server("browser", "connected"),
		]);
		expect(connected.octocode_work).toBe(browser.octocode_work);

		const researcher = await sections(
			{ isSubagent: true, role: "researcher", readOnly: true },
			["bash", "file", "mcp", "mcp__octocode__localSearch"],
			[server("octocode", "connected"), server("browser", "unselected")],
		);
		expect(researcher.octocode_work).toContain(MCP_RULE);
		expect(researcher.octocode_work).not.toContain(BROWSER_RULE);

		// Browser tools without a declared `browser.control` keep the generic rule: the runtime would ask for control.
		const inspector = await sections({ isSubagent: true, role: "inspector", readOnly: true }, browserTools, [
			server("browser", "connected"),
		]);
		expect(inspector.octocode_work).toContain(MCP_RULE);
		expect(inspector.octocode_work).not.toContain(BROWSER_RULE);
	});

	it("gives the native research fallback while the research server is unselected, not while it connects (T16)", async () => {
		const natives = ["bash", "file", "mcp"];
		const unselected = await sections({ isSubagent: true }, natives, [server("octocode", "unselected")]);
		expect(unselected.octocode_research).toContain("Search with bash (`rg`, `fd`)");
		const connecting = await sections({ isSubagent: true }, natives, [server("octocode", "connecting")]);
		expect(connecting.octocode_research).not.toContain("Search with bash");
		// Same as a disabled server: an agent that cannot reach the server is told how to research without it.
		const disabled = await sections({ isSubagent: true }, natives, [server("octocode", "disabled", false)]);
		expect(unselected.octocode_research).toBe(disabled.octocode_research);
	});
});

describe("child task text", () => {
	const identity = { id: "inky-kraken", role: "implementer", goal: "fix it", parentId: "salty-squid", item: "B1" };

	it("ships an implementer role that names no repository-specific file (T17)", () => {
		const role = readFileSync(new URL("../../src/octocode/instructions/roles/implementer.md", import.meta.url), "utf8");
		expect(role).not.toContain("architecture.test.ts");
		expect(role).not.toContain("instructions/");
		expect(role).toContain("including any agent instructions or tool descriptions you changed");
	});

	it("names the run mode only when the caller passes it, and renders both modes (T17)", () => {
		const plain = withIdentity("do it", identity);
		expect(plain).not.toMatch(/You run in the (back|fore)ground/);
		const background = withIdentity("do it", { ...identity, background: true });
		const foreground = withIdentity("do it", { ...identity, background: false });
		expect(background).toContain(BACKGROUND);
		expect(background).not.toContain(FOREGROUND);
		expect(foreground).toContain(FOREGROUND);
		expect(foreground).not.toContain(BACKGROUND);
		// The line joins the `## You` facts, after the backlog item; nothing else changes.
		expect(foreground).toBe(
			plain.replace("you may update no other item.", `you may update no other item. ${FOREGROUND}`),
		);
		expect(foreground.indexOf(FOREGROUND)).toBeLessThan(foreground.indexOf("## Report"));
	});

	it("appends exactly the identity block to the task, worktree note included", () => {
		const isolated = {
			...identity,
			background: true,
			isolation: { path: "/repo/.worktrees/inky", repo: "/repo", cwd: "/repo/.worktrees/inky/pkg" },
		};
		for (const each of [identity, isolated]) {
			const block = identityBlock(each, { library: "/archive/LIBRARY.md" });
			expect(block).not.toMatch(/^\s/);
			expect(withIdentity("do it", each, { library: "/archive/LIBRARY.md" })).toBe(`do it\n\n${block}`);
		}
		const block = identityBlock(isolated);
		expect(block.indexOf("/repo/.worktrees/inky/pkg")).toBeLessThan(block.indexOf("## You"));
	});
});
