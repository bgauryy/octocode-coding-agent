import path from "node:path";
import { parseConfigDocument } from "../../../utils/config-document.ts";
import { parseFrontmatter } from "../../../utils/frontmatter.ts";
import { projectHookFiles } from "../home.ts";
import { sanitizeTerminalText } from "../sanitize.ts";
import { isRecord } from "../../../utils/guards.ts";
import { projectConfigFiles, projectMcpFiles, readText, realPath } from "./files.ts";

/** Files listed without commands (agents, skills) past this many are summarized; command lines are never cut. */
const MAX_PLAIN_FILES = 40;

/** One dialog line: escape sequences stripped and newlines folded, so a value cannot draw or fake another line. */
const dialogLine = (text: string): string => sanitizeTerminalText(text).replace(/\s*\n\s*/g, " ⏎ ");

/**
 * What trusting would run: each file, with every `command`/`args`/`url` found in JSON configs (never cut) and the
 * environment variables their `headers`/`env` pass on. Files without commands past a cap are summarized.
 */
export function describeProjectConfig(cwd: string, files = projectConfigFiles(cwd)): string {
	const lines: string[] = [];
	let plain = 0;
	for (const file of files) {
		const shown = dialogLine(path.relative(realPath(cwd), file) || file);
		// A profile that declares permissions is listed with them, and never folded into the count of plain files.
		const runs =
			file.endsWith(".json") || file.endsWith(".toml")
				? commandsIn(executableConfig(file))
				: file.endsWith(".md")
					? permissionsIn(readText(file))
					: [];
		if (runs.length === 0 && ++plain > MAX_PLAIN_FILES) continue;
		lines.push(`- ${shown}${runs.length ? ":" : ""}`, ...runs.map((run) => `    ${dialogLine(run)}`));
	}
	if (plain > MAX_PLAIN_FILES) lines.push(`… ${plain - MAX_PLAIN_FILES} more file(s) without commands`);
	return lines.join("\n");
}

/** `permissions: browser.control` for a profile (a `.md` file) whose front matter names classes, every name as written (the profile loader decides which it honours); none for any other file. */
function permissionsIn(text: string): string[] {
	try {
		const value = parseFrontmatter(text).frontmatter.permissions;
		const names = (
			Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value === undefined ? [] : [value]
		)
			.map((name) => String(name).trim())
			.filter(Boolean);
		return names.length > 0 ? [`permissions: ${names.join(", ")}`] : [];
	} catch {
		return [];
	}
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function commandsIn(value: unknown, out: string[] = []): string[] {
	if (Array.isArray(value)) for (const item of value) commandsIn(item, out);
	else if (isRecord(value)) {
		if (typeof value.command === "string")
			out.push([value.command, ...(Array.isArray(value.args) ? value.args.map(String) : [])].join(" "));
		// An MCP-tool hook calls a tool on the user's server with the user's credentials: it acts like a command and needs
		// the same review. `input` is shown because its placeholders decide what the call sends.
		if (value.type === "mcp_tool" && typeof value.server === "string" && typeof value.tool === "string")
			out.push(
				`MCP ${value.server}/${value.tool}${value.input === undefined ? "" : ` ${JSON.stringify(value.input)}`}`,
			);
		for (const key of ["commandWindows", "command_windows"])
			if (typeof value[key] === "string") out.push(`Windows: ${value[key]}`);
		if (typeof value.url === "string") out.push(value.url);
		const sends = envSent(value);
		if (sends) out.push(sends);
		for (const [key, child] of Object.entries(value))
			if (key !== "args" && key !== "headers" && key !== "env" && typeof child === "object") commandsIn(child, out);
	}
	return out;
}

/** `  sends $A, $B (headers, env)` for the `${VAR}` references Octocode expands in a server's headers and env. */
function envSent(server: Record<string, unknown>): string | undefined {
	const names = new Set<string>();
	const where: string[] = [];
	for (const key of ["headers", "env"] as const) {
		const block = server[key];
		if (!isRecord(block)) continue;
		const before = names.size;
		for (const text of Object.values(block))
			for (const match of String(text).matchAll(ENV_REFERENCE)) names.add(match[1]);
		if (names.size > before) where.push(key);
	}
	return names.size > 0
		? `  sends your environment variables ${[...names].map((name) => `$${name}`).join(", ")} (in ${where.join(", ")})`
		: undefined;
}

/** Some hooks or MCP file among `files` (Claude Code, Codex, Octocode hooks; project `mcp.json`) holds a command, URL or args to run. */
export function startsCommands(cwd: string, files: string[], read: (file: string) => string = readText): boolean {
	const gated = new Set([...projectHookFiles(cwd).map(realPath), ...projectMcpFiles(cwd)]);
	return files.some((file) => gated.has(file) && commandsIn(executableConfig(file, read)).length > 0);
}

function executableConfig(file: string, read: (file: string) => string = readText): unknown {
	try {
		const value = parseConfigDocument(read(file), file);
		return file.endsWith(".toml") && isRecord(value) ? value.hooks : value;
	} catch {
		return undefined;
	}
}
