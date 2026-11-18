import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileEvents, type HookProtocol } from "../../../src/octocode/hooks/catalog.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(HERE, "record-hook.mjs");
const ECHO_MCP = path.join(HERE, "echo-mcp.mjs");

/** Events a one-tool prompt reaches; each profile is checked for the ones its catalog entry accepts. */
const REACHED = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
export const PROFILE_EVENTS = Object.fromEntries(
	(["octocode", "claude", "codex"] as const).map((protocol) => [
		protocol,
		profileEvents(protocol).filter((event) => REACHED.includes(event)),
	]),
) as Record<HookProtocol, string[]>;
export type Profile = HookProtocol;

const write = (file: string, content: string | object) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
};
const command = (log: string, tag: string) => `node ${JSON.stringify(RECORD)} ${JSON.stringify(log)} ${tag}`;
const jsonHooks = (log: string, tag: string, profile: Profile) => ({
	hooks: Object.fromEntries(
		PROFILE_EVENTS[profile].map((event) => [event, [{ hooks: [{ type: "command", command: command(log, tag) }] }]]),
	),
});
const tomlHooks = (log: string, tag: string) =>
	PROFILE_EVENTS.codex
		.map(
			(event) =>
				`[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = '${command(log, tag)}'\n`,
		)
		.join("\n");

/** Every standalone hook file Octocode reads: tag, file, profile. */
export function writeHookFiles(home: string, cwd: string, log: string): Array<{ tag: string; profile: Profile }> {
	const files: Array<{ tag: string; file: string; profile: Profile; toml?: true }> = [
		{ tag: "claude-user", file: path.join(home, ".claude/settings.json"), profile: "claude" },
		{ tag: "codex-user-json", file: path.join(home, ".codex/hooks.json"), profile: "codex" },
		{ tag: "codex-user-toml", file: path.join(home, ".codex/config.toml"), profile: "codex", toml: true },
		{ tag: "native-user", file: path.join(home, ".octocode/octocodecode/hooks.json"), profile: "octocode" },
		{ tag: "claude-project", file: path.join(cwd, ".claude/settings.json"), profile: "claude" },
		{ tag: "claude-local", file: path.join(cwd, ".claude/settings.local.json"), profile: "claude" },
		{ tag: "codex-project-json", file: path.join(cwd, ".codex/hooks.json"), profile: "codex" },
		{ tag: "codex-project-toml", file: path.join(cwd, ".codex/config.toml"), profile: "codex", toml: true },
		{ tag: "native-project", file: path.join(cwd, ".octocode/hooks.json"), profile: "octocode" },
	];
	for (const { tag, file, profile, toml } of files)
		write(file, toml ? tomlHooks(log, tag) : jsonHooks(log, tag, profile));
	return files.map(({ tag, profile }) => ({ tag, profile }));
}

const SKILL = (name: string) => `---\nname: ${name}\ndescription: Fixture skill ${name} for format checks.\n---\n\nSay hi.\n`;

/** One plugin per manifest format, each with a skill, hooks and a stdio MCP server; Claude adds a prompt command. */
export function writePlugins(root: string, log: string) {
	const plugins = [
		{ name: "claude-kit", protocol: "claude" as const, manifest: ".claude-plugin/plugin.json" },
		{ name: "codex-kit", protocol: "codex" as const, manifest: ".codex-plugin/plugin.json" },
		{ name: "portable-kit", protocol: "codex" as const, manifest: "plugin.json" },
	];
	return plugins.map(({ name, protocol, manifest }) => {
		const dir = path.join(root, name);
		write(path.join(dir, manifest), { name, version: "1.0.0", description: `${name} fixture` });
		write(path.join(dir, "skills/hello/SKILL.md"), SKILL("hello"));
		write(path.join(dir, "hooks/hooks.json"), jsonHooks(log, `plugin-${name}`, protocol));
		write(path.join(dir, ".mcp.json"), { mcpServers: { echo: { command: "node", args: [ECHO_MCP] } } });
		// Claude agents load as subagent profiles. Components no Octocode owner loads are reported as warnings, never silently dropped.
		if (protocol === "claude") write(path.join(dir, "agents/reviewer.md"), "---\nname: reviewer\n---\n\nReview.\n");
		if (protocol === "claude") write(path.join(dir, ".lsp.json"), {});
		if (name === "codex-kit") write(path.join(dir, ".app.json"), { apps: {} });
		if (protocol === "claude") write(path.join(dir, "commands/greet.md"), "---\ndescription: Greet\n---\n\nGreet $ARGUMENTS\n");
		return { path: dir, protocol, name };
	});
}

/** Skill folders other hosts install into, plus Octocode's own. */
export function writeSkills(home: string, cwd: string): string[] {
	const folders = {
		"claude-user-skill": path.join(home, ".claude/skills"),
		"codex-user-skill": path.join(home, ".codex/skills"),
		"agents-user-skill": path.join(home, ".agents/skills"),
		"agents-project-skill": path.join(cwd, ".agents/skills"),
		"claude-project-skill": path.join(cwd, ".claude/skills"),
		"octocode-project-skill": path.join(cwd, ".octocode/skills"),
	};
	for (const [name, folder] of Object.entries(folders)) write(path.join(folder, name, "SKILL.md"), SKILL(name));
	return Object.keys(folders);
}

const RECORDING_FEATURE = (log: string, tag: string) =>
	`import { appendFileSync } from "node:fs";\nexport default function (octocode) {\n\tconst record = (event, detail) => appendFileSync(${JSON.stringify(log)}, "${tag}\\t" + event + "\\t" + detail + "\\n");\n\toctocode.on("tool_call", (event) => record("tool_call", event.toolName));\n\toctocode.on("session_start", () => record("mcp_servers", octocode.getMcpServers().map((server) => server.name).join(",")));\n}\n`;

/** A native extension in the agent directory and a local Octocode package that declares one. */
export function writeFeatures(agentDir: string, root: string, log: string): { packageDir: string } {
	write(path.join(agentDir, "extensions/record.ts"), RECORDING_FEATURE(log, "extension-dir"));
	const packageDir = path.join(root, "record-package");
	write(path.join(packageDir, "package.json"), { name: "record-package", octocode: { extensions: ["./ext.ts"] } });
	write(path.join(packageDir, "ext.ts"), RECORDING_FEATURE(log, "package"));
	return { packageDir };
}
