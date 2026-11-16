import { redactUrlCredentials } from "@octocodeai/octocode-common/url-credentials";
import type { Settings } from "../../../core/settings-schema.ts";

/** Where a marketplace is fetched from, as stored under `marketplaces.<name>.source` in user settings. */
export type MarketplaceSource = NonNullable<Settings["marketplaces"]>[string]["source"];

/** Where one plugin of a marketplace comes from. `command`, `archive` and `npm` sources are not supported. */
export type PluginSource =
	| { kind: "relative"; path: string }
	| { kind: "git"; url: string; ref?: string; sha?: string; subdir?: string };

/** A refusal the user can act on; the message is printed as is. */
export class MarketplaceError extends Error {}

const ALLOWED_SCHEMES = ["https:", "ssh:", "git:", "file:"];
/** Letters, digits, `.`, `_` and `-`, starting with a letter or digit, as the Claude marketplace reference requires. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PREFIXES = ["claude-", "anthropic-", "claudeai-"];
const RESERVED_NAMES = new Set([
	"agent-skills",
	"life-sciences",
	"knowledge-work-plugins",
	"healthcare",
	"first-party-plugins",
	"financial-services-plugins",
	"inline",
	"builtin",
	"skills-dir",
	"synced",
	"npm",
	"pip",
	"uv",
	"cargo",
	"github",
	"gh",
	"constructor",
	"hasownproperty",
	"isprototypeof",
	"propertyisenumerable",
	"tolocalestring",
	"tostring",
	"valueof",
]);

/** A marketplace or plugin name: the part of `plugin@marketplace` the user types. */
export function checkIdentifier(kind: "marketplace" | "plugin", name: unknown): string {
	if (typeof name !== "string" || !NAME.test(name) || name.includes(".."))
		throw new MarketplaceError(
			`Invalid ${kind} name ${JSON.stringify(name)}: use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
		);
	return name;
}

/** Names that imitate Anthropic's marketplaces or that Claude Code keeps for itself are refused. */
export function checkMarketplaceName(name: unknown): string {
	const checked = checkIdentifier("marketplace", name);
	const lower = checked.toLowerCase();
	if (RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix)) || RESERVED_NAMES.has(lower))
		throw new MarketplaceError(
			`The marketplace name "${checked}" is reserved for official marketplaces: names starting with claude-, anthropic- or claudeai- and a few built-in names are refused.`,
		);
	return checked;
}

function checkRef(ref: string | undefined): string | undefined {
	if (ref === undefined) return undefined;
	if (!/^[\w][\w./-]*$/.test(ref) || ref.includes(".."))
		throw new MarketplaceError(`Invalid git ref ${JSON.stringify(ref)}.`);
	return ref;
}

/**
 * A git remote that Octocode may fetch: https, ssh, git or file URLs and `user@host:path`. Remote helpers (`ext::`,
 * `fd::`), other schemes, a leading dash (an option for git or ssh) and credentials in the URL are refused.
 */
export function checkGitUrl(url: string, options: { allowLocalPath?: boolean } = {}): string {
	const text = url.trim();
	if (!text) throw new MarketplaceError("The git URL is empty.");
	if (text.startsWith("-")) throw new MarketplaceError(`Refused git URL ${JSON.stringify(text)}: it starts with "-".`);
	if (/^[A-Za-z][\w+.-]*::/.test(text))
		throw new MarketplaceError(`Refused git URL: remote helpers such as "ext::" are not allowed.`);
	if (/[\u0000-\u001f\u007f]/.test(text))
		throw new MarketplaceError("Refused git URL: it contains control characters.");
	const scheme = /^([A-Za-z][\w+.-]*):\/\//.exec(text);
	if (scheme) {
		let parsed: URL;
		try {
			parsed = new URL(text);
		} catch {
			throw new MarketplaceError(`Refused git URL: ${redactUrl(text)} does not parse.`);
		}
		if (!ALLOWED_SCHEMES.includes(parsed.protocol))
			throw new MarketplaceError(
				`Refused git URL ${redactUrl(text)}: ${parsed.protocol.slice(0, -1)} is not allowed; use https, ssh, git or file.`,
			);
		// `ssh://git@host/...` names the account, not a secret; anywhere else a user name is a token.
		if (parsed.password || (parsed.username && parsed.protocol !== "ssh:"))
			throw new MarketplaceError(
				`Refused git URL ${redactUrl(text)}: URLs with embedded credentials are not supported. Use an SSH URL or a git credential helper.`,
			);
		return text;
	}
	// scp-style `git@host:path`
	if (/^[\w.-]+@[\w.-]+:[^:]/.test(text) && !text.includes("://")) {
		if (/^[^@]+:[^@]*@/.test(text))
			throw new MarketplaceError(`Refused git URL ${redactUrl(text)}: embedded credentials are not supported.`);
		return text;
	}
	if (options.allowLocalPath) return text;
	throw new MarketplaceError(
		`Refused git URL ${JSON.stringify(text)}: use an https, ssh, git or file URL, or user@host:path.`,
	);
}

const USERINFO = /(\/\/)[^/@\s]*@/;

/** A URL for output: a user name or password shown as `***@`, the value of a key- or token-like query parameter removed. */
export function redactUrl(url: string): string {
	const clean = redactUrlCredentials(url);
	// Not a URL `new URL` parses (or nothing to strip): mask any user info in the text as it stands.
	if (clean === url) return url.replace(USERINFO, "$1***@");
	return USERINFO.test(url) ? clean.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, "$1***@") : clean;
}

export type ParsedMarketplaceInput =
	| { kind: "local"; path: string }
	| { kind: "github"; repo: string; ref?: string }
	| { kind: "git"; url: string; ref?: string };

/**
 * The argument of `marketplace add`: a local path, `owner/repo[@ref]` (GitHub) or a git URL (`#ref` pins a ref).
 * `pathExists` decides whether `owner/repo` is a folder on disk rather than a GitHub repository.
 */
export function parseMarketplaceInput(input: string, pathExists: (text: string) => boolean): ParsedMarketplaceInput {
	const text = input.trim();
	if (!text) throw new MarketplaceError("Name a marketplace source: a local path, owner/repo or a git URL.");
	if (text.startsWith("-")) throw new MarketplaceError(`Unexpected option ${JSON.stringify(text)}.`);
	if (/^[A-Za-z][\w+.-]*::/.test(text)) checkGitUrl(text);
	if (/^(\.{1,2}(\/|$)|\/|~\/|[A-Za-z]:[\\/])/.test(text) || pathExists(text)) return { kind: "local", path: text };
	const github = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[@#]([^\s]+))?$/.exec(text);
	if (github && !text.includes(":"))
		return { kind: "github", repo: `${github[1]}/${github[2]}`, ref: checkRef(github[3]) };
	const hash = text.lastIndexOf("#");
	return {
		kind: "git",
		url: checkGitUrl(hash > 0 ? text.slice(0, hash) : text),
		ref: checkRef(hash > 0 ? text.slice(hash + 1) : undefined),
	};
}

/** The https URL of a GitHub `owner/repo`. */
function githubUrl(repo: string): string {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
		throw new MarketplaceError(`Invalid GitHub repository ${JSON.stringify(repo)}.`);
	return `https://github.com/${repo}.git`;
}

/** The git URL a stored marketplace source is fetched from. */
export function sourceUrl(source: MarketplaceSource): string | undefined {
	if (source.source === "github") return githubUrl(source.repo);
	if (source.source === "git") return source.url;
	return undefined;
}

/** One line for lists. */
export function describeSource(source: MarketplaceSource): string {
	if (source.source === "directory") return `directory ${source.path}`;
	const where = source.source === "github" ? `github ${source.repo}` : `git ${redactUrl(source.url)}`;
	return source.ref ? `${where}#${source.ref}` : where;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

function gitPluginUrl(value: unknown, field: string): string {
	if (typeof value !== "string") throw new MarketplaceError(`The ${field} of the plugin source must be a string.`);
	const shorthand = /^[\w.-]+\/[\w.-]+$/.test(value) && !value.includes(":");
	return shorthand ? githubUrl(value) : checkGitUrl(value);
}

/**
 * Read the `source` of a marketplace plugin entry. A relative path stays in the marketplace; `github`, `url` and
 * `git-subdir` are fetched by a shallow clone. Everything else is refused because it would run code or fetch code
 * Octocode cannot verify: `npm` and `archive` are not supported yet and `command` runs a command on this machine.
 */
export function parsePluginSource(raw: unknown, pluginRoot?: string): PluginSource {
	if (typeof raw === "string") {
		const bare = !raw.includes("/") && raw !== "." && pluginRoot;
		return { kind: "relative", path: bare ? `${pluginRoot.replace(/\/+$/, "")}/${raw}` : raw };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new MarketplaceError("The plugin source must be a path or an object with a source type.");
	const entry = raw as Record<string, unknown>;
	const optional = (field: string, check: (value: string) => string | undefined) =>
		entry[field] === undefined
			? undefined
			: typeof entry[field] === "string"
				? check(entry[field])
				: (() => {
						throw new MarketplaceError(`The ${field} of the plugin source must be a string.`);
					})();
	const ref = optional("ref", checkRef);
	const sha = optional("sha", (value) => {
		if (!FULL_SHA.test(value))
			throw new MarketplaceError("The sha of the plugin source must be a full 40-character lowercase commit.");
		return value;
	});
	switch (entry.source) {
		case "github":
			return { kind: "git", url: gitPluginUrl(entry.repo, "repo"), ref, sha };
		case "url":
			return { kind: "git", url: checkGitUrl(typeof entry.url === "string" ? entry.url : ""), ref, sha };
		case "git-subdir": {
			if (typeof entry.path !== "string" || !entry.path)
				throw new MarketplaceError("A git-subdir source needs a path.");
			const subdir = entry.path.startsWith("./") || entry.path === "." ? entry.path : `./${entry.path}`;
			return { kind: "git", url: gitPluginUrl(entry.url, "url"), ref, sha, subdir };
		}
		case "command":
			throw new MarketplaceError("command plugin sources run a command on this machine and are not supported.");
		default:
			throw new MarketplaceError(
				`Plugin source type ${JSON.stringify(entry.source)} is not supported; use a relative path, github, url or git-subdir.`,
			);
	}
}
