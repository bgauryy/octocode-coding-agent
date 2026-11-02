import type { Settings } from "./settings-schema.ts";

/**
 * Claude Code agent frontmatter, translated to the fields of an Octocode subagent profile. A plugin agent is untrusted
 * instruction content: only fields that mean the same thing in both products are carried over, and nothing here can
 * widen what the child may do (a tool allowlist without a file-writing tool makes the profile read-only; `permissions:`
 * still asks the user when the agent is spawned). Everything else is reported as unsupported and ignored.
 * Checked 2026-11-01 against https://code.claude.com/docs/en/sub-agents ("Frontmatter reference") and
 * https://code.claude.com/docs/en/plugins/components ("Frontmatter fields in plugin agents").
 */

type ToolEffect = "bash" | "web" | "write" | "inherent";

/**
 * Claude tool names (compared lowercase; Octocode's own names are accepted too) by what they mean in Octocode. `inherent`
 * tools exist in every child: local research (read, search, list), the `agent`, `archive` and `skill` tools.
 */
const TOOL_EFFECT: Record<string, ToolEffect> = {
	bash: "bash",
	web: "web",
	webfetch: "web",
	websearch: "web",
	file: "write",
	edit: "write",
	write: "write",
	multiedit: "write",
	notebookedit: "write",
	read: "inherent",
	grep: "inherent",
	glob: "inherent",
	ls: "inherent",
	notebookread: "inherent",
	todowrite: "inherent",
	skill: "inherent",
	agent: "inherent",
	task: "inherent",
	archive: "inherent",
};

/** Octocode fields a plugin agent may set: the ones that only narrow the child or ask the user. */
const NATIVE_FIELDS = new Set(["permissions", "readOnly"]);

function entries(value: unknown): string[] | undefined {
	if (typeof value === "string")
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
		return value.map((entry) => entry.trim()).filter(Boolean);
	return undefined;
}

interface ToolList {
	/** Octocode tool selectors: `bash`, `web`, `mcp__…` entries. */
	selectors: string[];
	writes: boolean;
	unsupported: string[];
}

/** `deny` lists accept a specifier (`Bash(git push *)` removes the whole tool, as in Claude); `tools` entries do not. */
function mapTools(list: string[], deny: boolean): ToolList {
	const result: ToolList = { selectors: [], writes: false, unsupported: [] };
	for (const entry of list) {
		const specified = /^([^()]+)\(.*\)$/.exec(entry);
		const name = specified && deny ? specified[1].trim() : entry;
		if (specified && !deny) {
			result.unsupported.push(entry);
			continue;
		}
		if (name.startsWith("mcp__")) {
			result.selectors.push(name);
			continue;
		}
		const effect = TOOL_EFFECT[name.toLowerCase()];
		if (effect === "bash" || effect === "web") result.selectors.push(effect);
		else if (effect === "write") result.writes = true;
		else if (effect === undefined) result.unsupported.push(entry);
	}
	result.selectors = [...new Set(result.selectors)];
	return result;
}

/** What `loadProfiles` takes to include plugin agents. */
export interface PluginProfileOptions {
	/** The `plugins` entries in effect (`effectivePlugins`); project entries are present only in a trusted folder. */
	plugins?: Settings["plugins"];
	/** A plugin agent's unsupported frontmatter, or a plugin agent that another profile replaced. */
	onNote?: (message: string) => void;
}

export interface TranslatedAgentFields {
	/** Octocode profile front matter (without `name`, which the loader sets from the scoped name). */
	frontmatter: Record<string, unknown>;
	/** Fields or entries that were not carried over, each as `field` or `field: entry`. */
	unsupported: string[];
}

export function translateAgentFields(source: Record<string, unknown>): TranslatedAgentFields {
	const out: Record<string, unknown> = {};
	const unsupported: string[] = [];
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || value === null || key === "name") continue;
		switch (key) {
			case "description":
			case "skills":
				out[key] = value;
				break;
			case "model":
				// `inherit` is the default: the child runs on the parent's model.
				if (typeof value !== "string") unsupported.push(key);
				else if (value.trim() !== "inherit") out.model = value;
				break;
			case "maxTurns":
				if (typeof value === "number" && Number.isInteger(value) && value > 0) out.maxRequests = value;
				else unsupported.push(`${key}: expected a positive integer`);
				break;
			case "tools":
			case "disallowedTools":
				break; // Below: the two lists decide each other's read-only effect.
			default:
				// Claude-only fields (permissionMode, hooks, mcpServers, effort, color, ...) and unknown keys alike.
				if (NATIVE_FIELDS.has(key)) out[key] = value;
				else unsupported.push(key);
		}
	}
	const allow = source.tools === undefined || source.tools === null ? undefined : entries(source.tools);
	const deny =
		source.disallowedTools === undefined || source.disallowedTools === null
			? undefined
			: entries(source.disallowedTools);
	if (source.tools !== undefined && source.tools !== null && !allow)
		unsupported.push("tools: expected a list of names");
	if (source.disallowedTools !== undefined && source.disallowedTools !== null && !deny)
		unsupported.push("disallowedTools: expected a list of names");
	let readOnly = out.readOnly === true;
	if (allow) {
		const mapped = mapTools(allow, false);
		unsupported.push(...mapped.unsupported.map((entry) => `tools: ${entry}`));
		// An absolute allowlist; with nothing Octocode adds beyond its own floor, keep every MCP tool (the allowlist's default).
		out.tools = mapped.selectors.length > 0 ? mapped.selectors.join(",") : "mcp__*";
		// A list that names no file-writing tool is a read-only agent in Claude: never grant it more here.
		if (!mapped.writes) readOnly = true;
	}
	if (deny) {
		const mapped = mapTools(deny, true);
		unsupported.push(...mapped.unsupported.map((entry) => `disallowedTools: ${entry}`));
		if (mapped.selectors.length > 0) out.excludeTools = mapped.selectors.join(",");
		// `file` stays in every child; a denied Edit or Write makes the agent read-only instead.
		if (mapped.writes) readOnly = true;
	}
	if (readOnly) out.readOnly = true;
	return { frontmatter: out, unsupported };
}
