import { createEventBus } from "@octocodeai/octocode-agent-core";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp, allSections } from "./helpers.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";

useResearchRoles();

describe("registerTurnSetup routing and child trim", () => {
	beforeEach(() => vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp()));
	afterEach(() => vi.unstubAllEnvs());

	const run = async (fake: ReturnType<typeof fakeHost>, selectedTools: string[]) => {
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools,
			},
		};
		await fake.emit("before_agent_start", event, {});
		return allSections(event);
	};

	it("keeps policy sections stable as an enabled research server connects or fails", async () => {
		const natives = ["bash", "file", "agent", "mcp"];
		const researchTools = [RESEARCH.search, RESEARCH.reader, RESEARCH.readOnly, RESEARCH.other];
		const fake = fakeHost();
		for (const name of [...natives, ...researchTools]) fake.tools.set(name, { name, exposure: "direct" });
		Object.assign(fake.api, { channels: createEventBus() });
		registerTurnSetup(fake.api, { isSubagent: false, profiles: () => new Map() });
		const status = (state: string, toolCount: number) => [
			{ name: RESEARCH.server, enabled: true, state, toolCount, source: "default", exposure: "direct" as const },
		];
		setMcpSessionStatus(fake.api.channels, status("connecting", 0));
		const before = await run(fake, natives);
		setMcpSessionStatus(fake.api.channels, status("connected", 4));
		const connected = await run(fake, [...natives, ...researchTools]);
		expect(connected.research).toBe(before.research);
		expect(connected.delegation).toBe(before.delegation);
		expect(connected.work).toBe(before.work);
		setMcpSessionStatus(fake.api.channels, status("failed", 0));
		const failed = await run(fake, natives);
		expect(failed.research).toBe(before.research);
	});

	it("leaves a child's docs and skills out of its system prompt", async () => {
		const fake = fakeHost();
		fake.tools.set("bash", { name: "bash", exposure: "direct" });
		registerTurnSetup(fake.api, { isSubagent: true, profiles: () => new Map() });
		const event = {
			systemPromptOptions: {
				sections: {} as Record<string, string>,
				baseSections: {} as Record<string, string>,
				selectedTools: ["bash"],
			},
		};
		await fake.emit("before_agent_start", event, {});
		expect(allSections(event).docs).toBe("");
		const prompt = buildSystemPrompt({
			cwd: "/tmp",
			selectedTools: ["bash", RESEARCH.reader],
			contextFiles: [],
			sections: allSections(event),
		});
		expect(prompt).not.toMatch(/<skills>|<available_skills>/);
	});
});
