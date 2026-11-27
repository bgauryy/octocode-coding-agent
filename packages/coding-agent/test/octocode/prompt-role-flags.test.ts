import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { READ_ONLY_ENV } from "@octocodeai/octocode-common/env";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { identityBlock, withIdentity } from "../../src/octocode/native/prompts/task.ts";
import { AGENT_ROLE_ENV } from "../../src/octocode/team/store/env.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { allSections, tmp } from "./helpers.ts";
import { publishRoles, RESEARCH_ENTRY } from "./fake-research-roles.ts";

vi.mock("../../src/octocode/cli/shim.ts", async (original) => ({
	...(await original<object>()),
	octocodeCliAvailable: () => false,
}));

const profile = (name: string, permissions: string[] = []) =>
	[name, { name, description: name, readOnly: true, permissions } as never] as const;
const PROFILES = new Map([profile("browser", ["browser.control"]), profile("researcher"), profile("inspector")]);

async function sections(
	options: { isSubagent: boolean; role?: string; readOnly?: boolean },
	selectedTools: string[],
	status: Parameters<typeof setMcpSessionStatus>[1],
): Promise<Record<string, string>> {
	if (options.role) vi.stubEnv(AGENT_ROLE_ENV, options.role);
	if (options.readOnly) vi.stubEnv(READ_ONLY_ENV, "1");
	const fake = fakeHost();
	for (const name of selectedTools) fake.tools.set(name, { name, exposure: "direct" });
	Object.assign(fake.api, { channels: createEventBus() });
	setMcpSessionStatus(fake.api.channels, status);
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

describe("policy flags derived from profiles and servers", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	it("keeps browser profile policy stable while connecting and distinguishes browser permission", async () => {
		const tools = ["file", "mcp", "mcp__browser__open", "mcp__browser__run"];
		const browser = await sections({ isSubagent: true, role: "browser", readOnly: true }, tools, [
			server("browser", "connecting"),
		]);
		const connected = await sections({ isSubagent: true, role: "browser", readOnly: true }, tools, [
			server("browser", "connected"),
		]);
		const inspector = await sections({ isSubagent: true, role: "inspector", readOnly: true }, tools, [
			server("browser", "connected"),
		]);
		expect(connected.work).toBe(browser.work);
		expect(inspector.work).not.toBe(browser.work);
	});

	it("names a vendor runner to a child only while its agent tool declares one", async () => {
		const subagent = async (properties: Record<string, unknown>) => {
			const fake = fakeHost();
			fake.tools.set("agent", { name: "agent", exposure: "direct", parameters: { type: "object", properties } });
			Object.assign(fake.api, { channels: createEventBus() });
			setMcpSessionStatus(fake.api.channels, []);
			registerTurnSetup(fake.api, { isSubagent: true, profiles: () => PROFILES });
			const event = { systemPromptOptions: { sections: {}, baseSections: {}, selectedTools: ["bash", "agent"] } };
			await fake.emit("before_agent_start", event, {});
			return allSections(event).subagent;
		};
		const runner = { type: "string", enum: ["claude-code"] };
		expect(await subagent({ type: {}, runner })).toContain("vendor runner");
		const without = await subagent({ type: {} });
		expect(without).toContain("you cannot start native Octocode subagents.");
		expect(without).not.toContain("vendor runner");
	});

	it("updates research policy for an unavailable server", async () => {
		const natives = ["bash", "file", "mcp"];
		publishRoles([{ ...RESEARCH_ENTRY, name: "octocode" }]);
		onTestFinished(() => publishRoles([]));
		const unselected = await sections({ isSubagent: true }, natives, [server("octocode", "unselected")]);
		const connecting = await sections({ isSubagent: true }, natives, [server("octocode", "connecting")]);
		const disabled = await sections({ isSubagent: true }, natives, [server("octocode", "disabled", false)]);
		expect(unselected.research).not.toBe(connecting.research);
		expect(unselected.research).toBe(disabled.research);
	});
});

describe("child task composition", () => {
	it("appends the identity block to the task, worktree note included", () => {
		const identity = { id: "inky-kraken", role: "implementer", goal: "fix it", parentId: "salty-squid", item: "B1" };
		const isolated = {
			...identity,
			background: true,
			isolation: { path: "/repo/.worktrees/inky", repo: "/repo", cwd: "/repo/.worktrees/inky/pkg" },
		};
		for (const each of [identity, isolated]) {
			const block = identityBlock(each, { library: "/archive/LIBRARY.md" });
			expect(withIdentity("do it", each, { library: "/archive/LIBRARY.md" })).toBe(`do it\n\n${block}`);
		}
		expect(identityBlock(isolated)).toContain("/repo/.worktrees/inky/pkg");
	});

	it("tells an isolated child what the dependency link left out, and that it can be resumed", () => {
		const base = { id: "inky-kraken", parentId: "salty-squid" };
		const at = { path: "/repo/.worktrees/inky", repo: "/repo", cwd: "/repo/.worktrees/inky" };
		const linked = identityBlock({ ...base, isolation: at });
		expect(linked).toContain("node_modules` are linked in");
		expect(linked).not.toContain("Report any check that needs what is missing");
		const partial = identityBlock({
			...base,
			isolation: { ...at, unlinked: "Not linked: packages/x/node_modules (missing)." },
		});
		expect(partial).toContain("except: Not linked: packages/x/node_modules (missing).");
		for (const block of [linked, partial]) {
			expect(block).toContain("coordinator can resume it");
			expect(block).not.toContain("cannot be continued");
		}
	});
});
