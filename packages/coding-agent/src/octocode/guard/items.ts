import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { mask, unhide } from "@octocodeai/octocode-common/shell-words";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { contentHash } from "./scan.ts";
import type { Finding, ItemFile, Rating, ReviewItem } from "./types.ts";

/**
 * Review items from what the loaders hold, as plain data: the guard imports no loader, so hooks, MCP and skills can ask
 * it without a cycle. Each builder reads the bytes once; those bytes are hashed and scanned.
 */

/** A skill folder larger than this is not hashed: it is reported as unreadable and cannot be approved. */
const SKILL_LIMITS = { files: 500, bytes: 8 * 1024 * 1024 };
/** A hook script larger than this is not read. */
const SCRIPT_LIMIT = 512 * 1024;

const SCRIPT_EXTENSIONS = new Set([
	".sh",
	".bash",
	".zsh",
	".fish",
	".py",
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".rb",
	".pl",
	".php",
	".ps1",
	".bat",
	".cmd",
	".exe",
	".lua",
	".go",
]);

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Whether a byte buffer is text: no NUL byte in its first 8 KB. */
const isText = (bytes: Buffer): boolean => !bytes.subarray(0, 8192).includes(0);

function fileOf(name: string, bytes: Buffer): ItemFile {
	return isText(bytes) ? { name, text: bytes.toString("utf8") } : { name, text: "", bytes };
}

/** A hook handler as the hook loader parsed it. `definition` is the handler's own fields, whatever its type. */
export interface HookItemInput {
	/** The `/harness` row id (`hook:<digest>`). */
	id: string;
	/** The file that defines the handler. */
	source: string;
	event: string;
	matcher: string;
	/** The handler's place among the event's handlers of that file: its identity holds no content. */
	position: number;
	type: "command" | "http" | "prompt" | "mcp_tool";
	/** The handler's definition, hashed and scanned as JSON. */
	definition: unknown;
	/** The shell command, for a command handler. */
	command?: string;
	label: string;
	scope: string;
	/** Where relative script paths in the command resolve. */
	cwd: string;
	home?: string;
}

type Pinned = { files: ItemFile[]; unreadable?: string };

/** Adds the bytes of `file` (named `word`) to `into`; false when it is no file or cannot be read. */
function pinFile(into: Pinned, word: string, file: string): boolean {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		// A word that names no file is part of the command, which is hashed whole.
		return false;
	}
	if (!stat.isFile()) return false;
	if (stat.size > SCRIPT_LIMIT) {
		into.unreadable ??= `${word} is larger than ${SCRIPT_LIMIT} bytes`;
		return true;
	}
	try {
		into.files.push(fileOf(`script ${word}`, readFileSync(file)));
	} catch (error) {
		// An existing file whose bytes cannot be read must not be approved unpinned.
		into.unreadable ??= `${word} cannot be read (${errorMessage(error)})`;
	}
	return true;
}

/**
 * Script files a command names that exist: `./x.sh`, `$CLAUDE_PROJECT_DIR/.claude/hooks/x.py`, `/abs/x.js`. With
 * `anyInProject`, a file inside `cwd` is pinned whatever its extension.
 */
function scriptFiles(command: string, cwd: string, anyInProject = false): Pinned {
	const pinned: Pinned = { files: [] };
	const expanded = command.replace(/\$\{?(?:CLAUDE_PROJECT_DIR|OCTOCODE_PROJECT_DIR|PWD)\}?/g, cwd);
	for (const raw of mask(expanded, []).split(/[\s;&|()<>]+/)) {
		const word = unhide(raw);
		const file = path.resolve(cwd, word);
		const known = SCRIPT_EXTENSIONS.has(path.extname(word).toLowerCase());
		if (!known && !(anyInProject && word && inside(file, cwd))) continue;
		pinFile(pinned, word, file);
		if (pinned.unreadable) break;
	}
	return pinned;
}

const HOOK_FLOORS: Record<HookItemInput["type"], Rating> = {
	command: "MEDIUM",
	mcp_tool: "MEDIUM",
	http: "HIGH",
	prompt: "LOW",
};

export function hookItem(input: HookItemInput): ReviewItem {
	const scripts = input.command ? scriptFiles(input.command, input.cwd) : { files: [] };
	const grants =
		input.type === "command"
			? ["Runs a shell command as you on every matching event", ...scripts.files.map((file) => `Runs ${file.name}`)]
			: input.type === "http"
				? ["Sends each matching event, with the tool input, to a web address"]
				: input.type === "mcp_tool"
					? ["Calls an MCP tool on every matching event"]
					: ["Asks a model to judge each matching event"];
	return {
		kind: "hook",
		id: input.id,
		identity: JSON.stringify([input.source, input.event, input.matcher, input.position]),
		scope: input.scope,
		label: `${input.event} [${input.matcher || "*"}] ${input.label}`,
		path: homeTilde(input.source, input.home),
		grants,
		floor: HOOK_FLOORS[input.type],
		files: [
			{ name: "handler", text: JSON.stringify(input.definition, null, 1) },
			...(input.command ? [{ name: "command", text: input.command }] : []),
			...scripts.files,
		],
		...(scripts.unreadable ? { unreadable: scripts.unreadable } : {}),
	};
}

/** An MCP entry as `mcp.json` holds it: what launches the server and what it receives. */
export interface McpItemInput {
	name: string;
	source: string;
	scope: string;
	config: Record<string, unknown>;
	home?: string;
}

const asStrings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Names of a variable map, with the values that run something (`!command`) or expand from the environment: a rotated
 * token does not ask again, a changed command does. Configured PATH and NODE_OPTIONS select executable code, so their
 * literal values are pinned as digests; this neither resolves credentials nor pins every server-specific variable.
 */
function variables(value: unknown, execution = false): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, entry] of Object.entries(asRecord(value)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const selector = execution && ["NODE_OPTIONS", "PATH"].includes(name.toUpperCase());
		out[name] =
			typeof entry !== "string"
				? ""
				: entry.startsWith("!") || entry.includes("$(")
					? entry
					: selector
						? `sha256:${sha256(entry)}`
						: "";
	}
	return out;
}

/** The parts of an entry that decide what runs and what it receives; switches such as `enabled` are not content. */
function launchContent(config: Record<string, unknown>): Record<string, unknown> {
	return {
		type: config.type ?? null,
		command: config.command ?? null,
		args: asStrings(config.args),
		cwd: config.cwd ?? null,
		url: config.url ?? null,
		env: variables(config.env, true),
		headers: variables(config.headers),
		inheritEnv: config.inheritEnv ?? null,
		install: config.install ?? null,
		auth: config.auth ?? null,
		// Only an opt-in is content: an absent or false flag leaves the record as earlier versions wrote it, so servers
		// approved before the field existed stay approved, while switching the sandbox off asks again.
		...(config.sandbox === true ? { sandbox: true } : {}),
	};
}

export function mcpItem(input: McpItemInput): ReviewItem {
	const content = launchContent(input.config);
	const url = typeof content.url === "string" ? content.url : undefined;
	const launch = url ?? [content.command, ...(content.args as string[])].filter(Boolean).join(" ");
	const secretNames = Object.keys(content.env as object).concat(Object.keys(content.headers as object));
	const findings: Finding[] = [];
	const secrets = secretNames.filter((name) => SECRET_NAME.test(name));
	if (secrets.length) findings.push({ rule: "secret-env", rating: "HIGH", text: `Receives ${secrets.join(", ")}` });
	if (content.inheritEnv === true)
		findings.push({ rule: "inherits-env", rating: "HIGH", text: "Receives your whole environment (inheritEnv)" });
	return {
		kind: "mcp",
		id: `mcp:${input.name}`,
		identity: input.name,
		scope: input.scope,
		label: input.name,
		path: homeTilde(input.source, input.home),
		grants: [
			url ? `Connects to ${url}` : `Starts \`${launch}\` as you, with your file access`,
			...(secretNames.length ? [`Receives ${secretNames.join(", ")}`] : []),
			"Offers tools the agent can call",
		],
		floor: url ? "HIGH" : "MEDIUM",
		files: [
			{ name: "entry", text: JSON.stringify(content, null, 1) },
			{ name: "launch", text: launch },
		],
		...(findings.length ? { preset: findings } : {}),
	};
}

export interface SkillItemInput {
	name: string;
	/** The skill's file (`SKILL.md`, or a single Markdown file). */
	filePath: string;
	scope: string;
	/** Names of the skills Octocode ships: a reviewed skill that takes one replaces it. */
	bundledNames?: ReadonlySet<string>;
	home?: string;
}

/** Every file under a folder, sorted, within the limits; `over` names the limit passed. */
function folderFiles(dir: string): { files: ItemFile[]; executable: boolean; over?: string } {
	const files: ItemFile[] = [];
	let bytes = 0;
	let executable = false;
	const walk = (relative: string): string | undefined => {
		const entries = readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const over = walk(name);
				if (over) return over;
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const full = path.join(dir, name);
			const stat = statSync(full);
			if (!stat.isFile()) return `linked directory or non-file ${name} cannot be reviewed as a skill file`;
			bytes += stat.size;
			if (files.length >= SKILL_LIMITS.files) return `more than ${SKILL_LIMITS.files} files`;
			if (bytes > SKILL_LIMITS.bytes) return `more than ${SKILL_LIMITS.bytes} bytes`;
			if (SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || (stat.mode & 0o111) !== 0) executable = true;
			files.push(fileOf(name, readFileSync(full)));
		}
		return undefined;
	};
	const over = walk("");
	return { files, executable, ...(over ? { over } : {}) };
}

/** A folder skill (`<dir>/SKILL.md`) hashes every file under its folder; a single-file skill hashes that file. */
export function skillItem(input: SkillItemInput): ReviewItem {
	const folder = path.basename(input.filePath) === "SKILL.md";
	const root = folder ? path.dirname(input.filePath) : input.filePath;
	let read: { files: ItemFile[]; executable: boolean; over?: string };
	try {
		read = folder ? folderFiles(root) : { files: [fileOf(path.basename(root), readFileSync(root))], executable: false };
	} catch (error) {
		read = { files: [], executable: false, over: (error as Error).message };
	}
	const findings: Finding[] = [];
	if (input.bundledNames?.has(input.name))
		findings.push({
			rule: "bundled-name",
			rating: "CRITICAL",
			text: `Takes the name of the skill Octocode ships as ${input.name}`,
		});
	return {
		kind: "skill",
		id: `skill:${homeTilde(input.filePath, input.home)}`,
		identity: root,
		scope: input.scope,
		label: input.name,
		path: homeTilde(root, input.home),
		grants: read.executable
			? ["Instructions the agent follows", "Scripts the agent may run as you"]
			: ["Instructions the agent follows"],
		floor: read.executable ? "MEDIUM" : "LOW",
		files: read.files,
		...(read.over ? { unreadable: read.over } : {}),
		...(findings.length ? { preset: findings } : {}),
	};
}

export interface AgentItemInput {
	/** The entry's provider id. */
	id: string;
	kind: "acp" | "cli";
	command: string;
	args: readonly string[];
	/** Names of the variables it receives. */
	env: readonly string[];
	/** The settings file that declares it. */
	source: string;
	scope: string;
	/** The project folder: relative paths resolve here, and a program or script inside it is pinned by its bytes. */
	cwd: string;
	/** The file `command` resolves to, when it was found. */
	executable?: string;
	home?: string;
}

const inside = (file: string, folder: string): boolean => {
	const relative = path.relative(folder, file);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The project files an entry pins: the scripts its arguments name and its own program when it lies in the project. */
function agentScripts(input: AgentItemInput): Pinned {
	const scripts = scriptFiles(input.args.join(" "), input.cwd, true);
	if (input.executable && inside(input.executable, input.cwd)) pinFile(scripts, input.command, input.executable);
	return scripts;
}

/**
 * The hash of the project files an entry pins, read now; undefined when it pins none. A later call that differs means
 * a file changed after the entry was approved.
 */
export function agentPinHash(input: AgentItemInput): string | undefined {
	const { files, unreadable } = agentScripts(input);
	return files.length || unreadable ? `${contentHash(files)}${unreadable ?? ""}` : undefined;
}

/**
 * A project's `externalModels` entry: its launch (kind, command, arguments, variable names) is the approved content,
 * with the bytes of the program when it lies in the project and of any script its arguments name, so a changed script
 * asks again.
 */
export function agentItem(input: AgentItemInput): ReviewItem {
	const launch = [input.command, ...input.args].join(" ");
	const secrets = input.env.filter((name) => SECRET_NAME.test(name));
	const scripts = agentScripts(input);
	return {
		kind: "agent",
		id: `agent:${input.id}`,
		identity: input.id,
		scope: input.scope,
		label: input.id,
		path: homeTilde(input.source, input.home),
		grants: [
			`Starts \`${launch}\` as you, with your file access, to answer this session's turns`,
			...(input.env.length ? [`Receives ${input.env.join(", ")}`] : []),
			...(input.kind === "acp" ? ["Calls the tools Octocode offers it"] : []),
		],
		floor: "MEDIUM",
		files: [
			{
				name: "entry",
				text: JSON.stringify({ kind: input.kind, command: input.command, args: input.args, env: input.env }, null, 1),
			},
			{ name: "launch", text: launch },
			...scripts.files,
		],
		...(scripts.unreadable ? { unreadable: scripts.unreadable } : {}),
		...(secrets.length
			? { preset: [{ rule: "secret-env", rating: "HIGH" as const, text: `Receives ${secrets.join(", ")}` }] }
			: {}),
	};
}
