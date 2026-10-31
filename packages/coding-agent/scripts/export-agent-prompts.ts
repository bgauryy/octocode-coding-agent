/** Export a hermetic native prompt fixture through the same role loader and turn hook as a session. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { SIDE_QUESTION_SYSTEM_PROMPT } from "../src/core/agent-session/side-question-prompt.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/core/compaction/utils.ts";
import octocode from "../src/octocode/index.ts";
import { ROLE_PROMPT_FILE_ENV, writeRolePrompt } from "../src/octocode/instructions/role.ts";
import { teamTask, withIdentity } from "../src/octocode/instructions/task.ts";
import { loadProfiles, profileSelectsTool } from "../src/octocode/subagents/profiles.ts";
import { registerTurnSetup } from "../src/octocode/turn.ts";
import { HOOK_EVALUATION_SYSTEM_PROMPT } from "../src/octocode/hooks/prompt.ts";
import { defineOctocodeTool, octocodeToolName } from "../../mcp/src/presets/octocode/tools.ts";
import { renderContractSections } from "../../mcp/src/section.ts";
import type { Tool } from "../../mcp/src/client/index.ts";
import { fakeHost } from "../test/octocode/fake-host.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: export-agent-prompts.ts <output-directory> [captured-mcp-catalog.json]");
const catalog = process.argv[3]
	? (JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as {
			initialize: { instructions?: string };
			catalog: { tools: Tool[] };
		})
	: undefined;
const output = path.resolve(destination);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-prompt-export-"));
const previousEnv = { ...process.env };
fs.mkdirSync(output, { recursive: true });
try {
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("OCTOCODE_")) delete process.env[name];
	}
	process.env.OCTOCODE_HOME = temporary;
	process.env.OCTOCODE_CODING_AGENT_DIR = temporary;
	const profiles = loadProfiles(temporary, temporary, false, {});
	const inventory: Array<{ name: string; characters: number; estimatedTokens: number; tools: string[] }> = [];
	for (const name of ["coordinator", "general", ...profiles.keys()]) {
		const child = name !== "coordinator";
		const profile = profiles.get(name);
		delete process.env.OCTOCODE_SUBAGENT;
		delete process.env.OCTOCODE_READ_ONLY;
		delete process.env[ROLE_PROMPT_FILE_ENV];
		if (child) process.env.OCTOCODE_SUBAGENT = "1";
		if (profile?.readOnly) process.env.OCTOCODE_READ_ONLY = "1";
		if (profile?.prompt) process.env[ROLE_PROMPT_FILE_ENV] = writeRolePrompt(profile.prompt, temporary);
		const native = fakeHost();
		await octocode(native.api);
		for (const tool of catalog?.catalog.tools ?? []) {
			const definition = defineOctocodeTool({
				tool,
				server: "octocode",
				name: octocodeToolName(tool.name),
				timeoutMs: 60_000,
				namespace: { name: "mcp__octocode", instructions: catalog?.initialize.instructions },
				exposure: "direct",
				getClient: async () => {
					throw new Error("Prompt export does not execute MCP tools");
				},
			});
			native.api.registerTool(definition);
		}
		const defaults = native.api.getActiveTools();
		const selected = defaults.filter((tool) => !child || profileSelectsTool(profile, tool, defaults));
		const tools = native.api.getAllTools().filter((tool) => selected.includes(tool.name));
		const turn = fakeHost();
		for (const tool of tools) turn.tools.set(tool.name, tool);
		turn.api.setActiveTools(selected);
		registerTurnSetup(turn.api, {
			isSubagent: child,
			profiles: () => profiles,
		});
		const options = normalizeBuildSystemPromptOptions({
			cwd: "/workspace/project",
			selectedTools: selected,
			toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, tool.promptSnippet ?? ""])),
			toolGuidelines: Object.fromEntries(tools.map((tool) => [tool.name, tool.promptGuidelines ?? []])),
			contextFiles: [],
			skills: [],
		});
		await turn.emit("before_agent_start", { systemPromptOptions: options }, {});
		if (catalog)
			Object.assign(
				options.sections,
				renderContractSections([
					{
						entry: {
							name: "octocode",
							config: { command: "fixture", exposure: "direct" },
							source: "prompt fixture",
							scope: "default",
						},
						state: "connected",
						instructions: catalog.initialize.instructions,
						declared: tools.some((tool) => tool.name.startsWith("mcp__")),
					},
				]),
			);
		const prompt = buildSystemPrompt(options);
		fs.writeFileSync(path.join(output, `${name}.system.md`), `${prompt}\n`);
		fs.writeFileSync(
			path.join(output, `${name}.tools.json`),
			`${JSON.stringify(
				tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
				null,
				2,
			)}\n`,
		);
		if (child) {
			const task = teamTask("[Assigned objective, scope, known facts and acceptance checks]", "parent-example", []);
			fs.writeFileSync(
				path.join(output, `${name}.task.md`),
				`${withIdentity(task, {
					id: "child-example",
					role: name,
					parentId: "parent-example",
					scratch: "/workspace/project/.octocode/tmp/agents/child-example",
				})}\n`,
			);
		}
		inventory.push({ name, characters: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4), tools: selected });
	}
	fs.writeFileSync(path.join(output, "side-question.system.md"), `${SIDE_QUESTION_SYSTEM_PROMPT}\n`);
	fs.writeFileSync(path.join(output, "summarization.system.md"), `${SUMMARIZATION_SYSTEM_PROMPT}\n`);
	fs.writeFileSync(path.join(output, "hook-evaluator.system.md"), `${HOOK_EVALUATION_SYSTEM_PROMPT}\n`);
	if (catalog) fs.writeFileSync(path.join(output, "mcp-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
	fs.writeFileSync(
		path.join(output, "manifest.json"),
		`${JSON.stringify(
			{
				fixture: "Native registration, bundled profile parser, registerTurnSetup, buildSystemPrompt; no model call",
				configuration: `${catalog ? "Captured MCP catalog declared directly through the native adapter" : "MCP disabled"}; no user/project instructions, custom profiles, skills, hooks, memory or runtime plan state. Cwd and child task identifiers are representative fixture values. Tool definitions are separate model input, not system text.`,
				estimate: "ceil(system prompt characters / 4); not tokenizer measurements or behavioral evaluations",
				auxiliary: {
					"side-question": "core/agent-session/side-question-prompt.ts",
					"prompt-hook evaluator": "octocode/hooks/prompt.ts",
					"compaction and branch summary":
						"core/compaction/utils.ts; task-specific format is supplied separately as user content",
				},
				agents: inventory,
			},
			null,
			2,
		)}\n`,
	);
	process.stdout.write(`${output}\n`);
} finally {
	process.env = previousEnv;
	fs.rmSync(temporary, { recursive: true, force: true });
}
