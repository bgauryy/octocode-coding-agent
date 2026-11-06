import fs from "node:fs";
import path from "node:path";
import type { McpServerEntry } from "./config.ts";
import { hostPaths } from "./host.ts";
import { warnOnce } from "./warnings.ts";

/** What a launch template can name. */
export interface McpLaunchContext {
	cwd: string;
	projectTrusted: boolean;
	/** Loaded skill folders: research servers may read them. */
	skillDirectories?: readonly string[];
	env?: NodeJS.ProcessEnv;
}

const MCP_LAUNCH_TEMPLATES = ["workspace", "researchRoots", "agentDir", "projectTrusted"] as const;
type TemplateName = (typeof MCP_LAUNCH_TEMPLATES)[number];
/** `${untrusted:<value>}`: `<value>` in an untrusted project; in a trusted one, empty, and alone it omits its entry. */
const UNTRUSTED = "untrusted";
const KNOWN = [...MCP_LAUNCH_TEMPLATES.map((known) => `\${${known}}`), `\${${UNTRUSTED}:<value>}`].join(", ");

/**
 * A launch template: `${name}` with a lowercase first letter, not preceded by `$` (`$${name}` stays literal), or
 * `${untrusted:<value>}`. Uppercase names (`${HOME}`) are environment references, resolved later like every configured
 * env value.
 */
const TEMPLATE = /(?<!\$)\$\{([a-z][A-Za-z0-9]*)(?::([^}]*))?\}/g;
/** An env value or arg that is one `${untrusted:<value>}` and nothing else: left out in a trusted project. */
const ONLY_UNTRUSTED = /^\$\{untrusted:[^}]*\}$/;

/** The nearest folder at or above `cwd` holding `.git`, else `cwd`. */
function repositoryRoot(cwd: string): string {
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		if (path.dirname(dir) === dir) return path.resolve(cwd);
	}
}

/**
 * The folders a research server's readers may reach, comma-separated: the workspace, the session folders (spilled
 * output, logs, archives), loaded skills and the folders the user added (`McpPathsPort.researchRoots`, whose rejected
 * entries become launch warnings). Not the agent home itself: credentials and the agent database stay out of reach.
 */
function researchRoots(context: McpLaunchContext): string {
	const paths = hostPaths();
	const user = paths.researchRoots?.(context.env);
	for (const warning of user?.warnings ?? []) warnOnce(warning);
	return [
		...new Set([
			context.cwd,
			...paths.sessionRoots(context.cwd, context.env),
			...[...new Set(context.skillDirectories)].sort(),
			...(user?.roots ?? []),
		]),
	].join(",");
}

function templateValue(name: TemplateName, context: McpLaunchContext): string {
	switch (name) {
		case "workspace":
			return repositoryRoot(context.cwd);
		case "researchRoots":
			return researchRoots(context);
		case "agentDir":
			return hostPaths().agentDir();
		case "projectTrusted":
			return String(context.projectTrusted);
	}
}

const isTemplateName = (name: string): name is TemplateName => MCP_LAUNCH_TEMPLATES.some((known) => known === name);

/** `text` with its templates replaced; `escape` keeps the values literal through later `${}`/`!` resolution. */
function expand(
	text: string,
	value: (name: TemplateName) => string,
	trusted: boolean,
	where: string,
	escape: (value: string, atStart: boolean) => string,
): string {
	return text.replace(TEMPLATE, (_match, name: string, argument: string | undefined, offset: number) => {
		if (name === UNTRUSTED) {
			if (argument === undefined) throw new Error(`${where}: launch template \${${UNTRUSTED}:<value>} needs a value`);
			return escape(trusted ? "" : argument, offset === 0);
		}
		if (!isTemplateName(name)) throw new Error(`${where}: unknown launch template \${${name}} (known: ${KNOWN})`);
		if (argument !== undefined) throw new Error(`${where}: launch template \${${name}} takes no value`);
		return escape(value(name), offset === 0);
	});
}

/** Configured env values resolve `${NAME}` and a leading `!`: `$` becomes `$$` and a leading `!` becomes `$!`. */
const literalEnv = (value: string, atStart: boolean): string => {
	const escaped = value.replaceAll("$", "$$$$");
	return atStart ? escaped.replace(/^!/, "$!") : escaped;
};

/**
 * The entry with the launch templates in its stdio `args` and `env` values replaced, for every server alike. Values are
 * computed once per launch and only when named. An unknown template throws an error naming it. In a trusted project an
 * arg or env value that is a lone `${untrusted:<value>}` is left out, so the server's own default or setting applies.
 */
export function expandLaunchTemplates(entry: McpServerEntry, context: McpLaunchContext): McpServerEntry {
	const { config } = entry;
	if ("url" in config) return entry;
	const named = [...(config.args ?? []), ...Object.values(config.env ?? {})].some((text) => text.match(TEMPLATE));
	if (!named) return entry;
	const cache = new Map<TemplateName, string>();
	const value = (name: TemplateName): string => {
		if (!cache.has(name)) cache.set(name, templateValue(name, context));
		return cache.get(name)!;
	};
	const label = `MCP server "${entry.name}"`;
	const trusted = context.projectTrusted;
	const kept = (text: string) => !(trusted && ONLY_UNTRUSTED.test(text));
	const args = config.args?.map((arg, index) =>
		kept(arg) ? expand(arg, value, trusted, `${label} args[${index}]`, (text) => text) : undefined,
	);
	return {
		...entry,
		config: {
			...config,
			...(args ? { args: args.filter((arg) => arg !== undefined) } : {}),
			...(config.env
				? {
						env: Object.fromEntries(
							Object.entries(config.env)
								.filter(([, text]) => kept(text))
								.map(([key, text]) => [key, expand(text, value, trusted, `${label} env "${key}"`, literalEnv)]),
						),
					}
				: {}),
		},
	};
}
