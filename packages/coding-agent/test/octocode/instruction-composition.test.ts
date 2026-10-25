import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, type TranscriptContext } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	normalizeBuildSystemPromptOptions,
} from "../../src/core/system-prompt.ts";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../../src/octocode/instructions/role.ts";
import { registerTurnSetup } from "../../src/octocode/turn.ts";
import { createHarness } from "../suite/harness.ts";
import { fakePi } from "./fake-pi.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "instruction-composition-"));
	vi.stubEnv("OCTOCODE_HOME", root);
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("composes a child role once alongside discovered user and project instructions", async () => {
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "User append sentinel.");
	writeFileSync(join(cwd, "AGENTS.md"), "Project instruction sentinel.");
	const role = "Role instruction sentinel.";
	vi.stubEnv(ROLE_PROMPT_FILE_ENV, writeRolePrompt(role, root));
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		nativeFeatures: false,
		noExtensions: true,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
	});
	await loader.reload();
	const fake = fakePi();
	registerTurnSetup(fake.pi, {
		isSubagent: true,
		profiles: () => new Map(),
	});
	const options = normalizeBuildSystemPromptOptions({
		cwd,
		selectedTools: ["read", "sendMessage", "coordinate", "archive"],
		appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
		contextFiles: loader.getAgentsFiles().agentsFiles,
	});
	await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
	const prompt = buildSystemPrompt(options);
	for (const sentinel of ["User append sentinel.", "Project instruction sentinel.", role]) {
		expect(prompt.split(sentinel)).toHaveLength(2);
	}
	expect(options.sections.role).toBe(role);
	expect(options.appendSystemPrompt).toBe("User append sentinel.");
	expect(prompt).toContain("You are a subagent");
	expect(prompt).not.toContain("Delegate bounded work");
	expect(prompt).not.toContain(process.env[ROLE_PROMPT_FILE_ENV]);
});

it("updates the named policy section when selected research tools change", async () => {
	const fake = fakePi();
	registerTurnSetup(fake.pi, {
		isSubagent: false,
		profiles: () => new Map(),
	});
	const render = async (selectedTools: string[]) => {
		const options = normalizeBuildSystemPromptOptions({ cwd: root, selectedTools });
		await fake.emit("before_agent_start", { systemPromptOptions: options }, {});
		return buildSystemPromptSections(options);
	};
	const first = await render(["read", "mcp__octocode__localSearch"]);
	const unchanged = await render(["read", "mcp__octocode__localSearch"]);
	expect(diffSystemPromptSections(first, unchanged)).toBeUndefined();
	const removed = await render(["read"]);
	expect(first.octocode_research).toContain("Use Octocode MCP");
	expect(removed.octocode_research).not.toContain("Use Octocode MCP");
	expect(diffSystemPromptSections(first, removed)).toHaveProperty("octocode_research", removed.octocode_research);
	expect(removed.preamble).toBe(first.preamble);
});

it("sends the updated policy to the model through the real session pipeline", async () => {
	const name = "mcp__octocode__localSearch";
	const harness = await createHarness({
		initialActiveToolNames: ["read", name],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name,
					label: "Research fixture",
					description: "Offline research fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				});
				registerTurnSetup(pi, {
					isSubagent: false,
					profiles: () => new Map(),
				});
			},
		],
	});
	try {
		const requests: TranscriptContext[] = [];
		harness.setResponses(
			["first", "second"].map((answer) => (context: TranscriptContext) => {
				requests.push(context);
				return fauxAssistantMessage(answer);
			}),
		);
		await harness.session.prompt("first");
		harness.session.setActiveToolsByName(["read"]);
		await harness.session.prompt("second");
		expect(requests).toHaveLength(2);
		expect(getCurrentSystemPrompt(requests[0].messages)).toContain("Use Octocode MCP");
		expect(getCurrentSystemPrompt(requests[1].messages)).not.toContain("Use Octocode MCP");
		expect(requests[1].messages[0]).toEqual(requests[0].messages[0]);
	} finally {
		harness.cleanup();
	}
});
