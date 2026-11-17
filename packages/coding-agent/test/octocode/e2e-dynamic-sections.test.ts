import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableHarnesses } from "./e2e-helpers/harness-toggles.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	script,
	startEndpoint,
} from "./e2e-real-process-harness.ts";

/**
 * The prompt follows what a session loaded, end to end in a real process: a configured MCP server, skill and hook each
 * appear under their own marker, as the model receives them, and leave no trace once the configuration is gone. Nothing
 * about them is written in the instructions.
 */
const DOCS_SERVER = path.join(import.meta.dirname, "fixtures", "docs-mcp.mjs");
const HOOK_COMMAND = "echo SECRET-HOOK-COMMAND";

let endpoint: Endpoint;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

/** Every block a tag wraps, joined: a split section (`mcps`, `project_context`) repeats its tag once per part. */
const section = (prompt: string, name: string): string | undefined => {
	const blocks = [...prompt.matchAll(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`, "g"))].map(
		(match) => match[1],
	);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
};

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** The system prompt of one real run in `box`. */
async function promptOf(box: ReturnType<typeof sandbox>): Promise<string> {
	const run = box.start(["-p", script([{ text: "done" }])]);
	const { code } = await run.exited;
	expect(code).toBe(0);
	const request = endpoint.requests.at(-1);
	endpoint.requests.length = 0;
	return request?.system ?? "";
}

describe("sections built from what the session loaded", () => {
	it("adds a configured MCP server, skill and hook under their own markers, and removes them with the configuration", async () => {
		const box = sandbox(endpoint);
		const mcp = path.join(box.home, ".octocode", "octocodecode", "mcp.json");
		const skill = path.join(box.home, ".agents", "skills", "demo-skill", "SKILL.md");
		const hooks = path.join(box.home, ".claude", "settings.json");

		// The hook file is Claude Code's, which loads only once its harness is on.
		enableHarnesses(box, "claude");
		write(
			mcp,
			JSON.stringify({
				mcpServers: {
					octocode: { command: "false", enabled: false },
					docs: { command: process.execPath, args: [DOCS_SERVER], exposure: "direct" },
				},
			}),
		);
		write(
			skill,
			"---\nname: demo-skill\ndescription: Use for demo work in this test.\n---\n# Demo\n\nDEMO-SKILL-BODY\n",
		);
		write(
			hooks,
			JSON.stringify({
				hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
			}),
		);

		const loaded = await promptOf(box);
		expect(section(loaded, "mcps")).toContain('<mcp name="docs" tools="mcp__docs__*">');
		expect(section(loaded, "mcps")).toContain("lookup");
		const skills = section(loaded, "skills");
		expect(skills).toContain("demo-skill");
		expect(skills).toContain("Use for demo work in this test.");
		// A skill's body loads on demand: the catalog names it and no more.
		expect(loaded).not.toContain("DEMO-SKILL-BODY");
		expect(section(loaded, "hooks")).toContain("- PreToolUse: Bash");
		// A hook's command can hold a secret.
		expect(loaded).not.toContain("SECRET-HOOK-COMMAND");

		// Every dynamic section comes after the rules that do not change with configuration, in the order of the map.
		const order = ["<tools>", "<mcps>", "<work>", "<skills>", "<hooks>"].map((tag) => loaded.indexOf(tag));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));

		write(mcp, JSON.stringify({ mcpServers: { octocode: { command: "false", enabled: false } } }));
		fs.rmSync(path.dirname(skill), { recursive: true });
		fs.rmSync(hooks);

		const bare = await promptOf(box);
		expect(bare).not.toContain("mcp__docs__");
		expect(bare).not.toContain("demo-skill");
		expect(section(bare, "hooks")).toBeUndefined();
		// The same instructions, with nothing about what was removed left in them.
		expect(section(bare, "work")).toBe(section(loaded, "work"));
	});
});
