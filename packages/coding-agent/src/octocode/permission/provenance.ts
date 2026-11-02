import { archiveMutation } from "../shared/archive-operation.ts";
import type { ToolCallEvent, ToolResultEvent } from "../../core/features/index.ts";
import { browserMcpUrls } from "../../../../common/src/browser-mcp.ts";
import { formatAgo } from "../shared/format.ts";
import { readPaths, resolveToolPath, tildePath } from "../shared/home.ts";
import { isMcpToolName } from "../../../../mcp/src/servers.ts";
import { LOCAL_RESEARCH_TOOLS } from "../../../../mcp/src/presets/octocode/names.ts";
import { secretProblem } from "../../../../common/src/sanitize.ts";
import { contentText } from "../shared/util.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../shared/home/repo.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { runsLater } from "./file-access.ts";
import { KeyTable } from "./key-table.ts";
import { commandNames, SHELL_TOOLS } from "./shell.ts";
import { atoms, capBytes, decoded, normalize, RUN, shingles, tokens, URL_PATTERN } from "./provenance/keys.ts";
import { outsideShellRead } from "./provenance/shell-reads.ts";

/**
 * Files that run when invoked: scripts by extension, anything under a `bin/` or `scripts/` folder, files make, just and
 * direnv run, and CI workflows. Untrusted text written there is an action waiting to happen, so it stays a sink; any
 * other workspace file just stores it.
 */
const EXECUTABLE =
	/\.(?:sh|bash|zsh|fish|ksh|ps1|psm1|bat|cmd|command)$|(?:^|\/)(?:bin|scripts)\/|(?:^|\/)(?:makefile|gnumakefile|justfile|\.envrc)$|(?:^|\/)\.github\/workflows\//i;
/** What a hit on a shell command adds: saving quoted material as data is fine, running it is the risk. */
const SHELL_HINT = "; to save quoted material, write it as data with the `file` tool, not a shell command";

/**
 * A CaMeL-inspired provenance tripwire: tool outputs are tagged by where they came from, and a later call
 * whose arguments repeat them is flagged. `untrusted` output (web, browser, MCP, network commands) reaching a
 * consequential argument (a shell command, file content, an MCP call, a memory) and `private` output (reads
 * outside the workspace, secret-looking lines) reaching an egress argument (a URL, a network command) are hits.
 * Workspace reads, by Octocode's local readers and searches as by the legacy `read` and `grep`, are trusted.
 *
 * It is substring matching, so paraphrase, encoding or splitting across calls defeat it by design: a tripwire, not
 * a sandbox. The index holds 53-bit hashes only, never the text, lives in memory per session and is never written.
 */

const MAX_SHINGLES = 200_000;
const MAX_BYTES_PER_RESULT = 256 * 1024;
/** Sources (labels and times) kept; a shingle whose source was pruned no longer hits. */
const MAX_SOURCES = 4096;
/** Cursors of local-tool pages kept with their origin; the oldest is dropped first. */
const MAX_CURSORS = 1024;
const CURSOR = /"cursor"\s*:\s*"([^"]+)"/g;

const NETWORK = new Set([
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"socat",
	"telnet",
	"ftp",
	"sftp",
	"scp",
	"ssh",
	"rsync",
	"http",
	"https",
	"xh",
	"aria2c",
	"lynx",
	"w3m",
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
]);
/** Argument keys that are not an action: the model's own explanation of a call. */
const NOT_ACTION = new Set(["reason", "reasoning", "oldText"]);

type Kind = "untrusted" | "private";
interface Source {
	kind: Kind;
	/** The tool and where its output came from: `web https://…`, `read ~/…`, `bash curl https://…`. */
	label: string;
	secret: boolean;
	at: number;
}

interface ProvenanceOptions {
	/** The repository root reads are trusted under (default: the git toplevel of `cwd`). */
	workspaceRoot?: (cwd: string) => string | undefined;
	maxShingles?: number;
	maxBytesPerResult?: number;
	now?: () => number;
}

interface ProvenanceHit {
	/** The dialog line: `contains text from web https://example.com/install (2m ago)`. */
	why: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The string leaves of a tool's arguments, minus keys that explain rather than act. */
function leaves(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) leaves(item, out);
	else if (isRecord(value))
		for (const [key, item] of Object.entries(value)) if (!NOT_ACTION.has(key)) leaves(item, out);
	return out;
}

const isNetworkCommand = (command: string): boolean =>
	commandNames(command).some((name) => NETWORK.has(name.toLowerCase()));

/** Octocode's local readers and searches, the native `read` and `grep`: known by the host's own names, not server hints. */
const LOCAL_TOOLS = new Set(LOCAL_RESEARCH_TOOLS);

class Provenance {
	/** Hash → its slot in the ring below. */
	private readonly index: KeyTable;
	/** Oldest-first eviction: `keys[slot]` is the hash written there, `ids[slot]` its source (0: an atom first seen in trusted output). */
	private keys: Float64Array | undefined;
	private ids: Int32Array | undefined;
	private head = 0;
	private readonly sources = new Map<number, Source>();
	/** A local tool's cursor → the origin of the page that returned it (null: trusted), so the next page inherits it. */
	private readonly cursors = new Map<string, { kind: Kind; label: string } | null>();
	private nextSource = 1;
	private readonly workspaceRoot: (cwd: string) => string | undefined;
	private readonly maxShingles: number;
	private readonly maxBytes: number;
	private readonly now: () => number;

	constructor(options: ProvenanceOptions = {}) {
		this.workspaceRoot = options.workspaceRoot ?? workspaceRoot;
		this.maxShingles = options.maxShingles ?? MAX_SHINGLES;
		this.index = new KeyTable(this.maxShingles);
		this.maxBytes = options.maxBytesPerResult ?? MAX_BYTES_PER_RESULT;
		this.now = options.now ?? Date.now;
	}

	/** Indexes a tool result by its source (a `tool_result` handler; nested tool results included). */
	record(event: ToolResultEvent, ctx: { cwd: string }): void {
		const text = capBytes(contentText(event.content), this.maxBytes);
		if (!text) return;
		const origin = this.origin(event, ctx.cwd);
		if (LOCAL_TOOLS.has(event.toolName))
			for (const [, cursor] of text.matchAll(CURSOR)) {
				this.cursors.delete(cursor);
				this.cursors.set(cursor, origin ?? null);
				if (this.cursors.size > MAX_CURSORS) this.cursors.delete(this.cursors.keys().next().value!);
			}
		if (origin?.kind === "untrusted") {
			// The source's own address was chosen before its content was read.
			for (const key of atoms(origin.label)) this.remember(key, 0, false);
			// Echoed arguments were supplied before this result. Exclude only new taint; keep any earlier source.
			const supplied = capBytes(leaves(event.input).join("\n"), this.maxBytes);
			const echoed = new Set([...atoms(supplied), ...shingles(normalize(supplied))]);
			const id = this.addSource(origin.kind, origin.label, false);
			for (const key of atoms(text)) if (!echoed.has(key)) this.remember(key, id, false);
			for (const key of shingles(normalize(text))) if (!echoed.has(key)) this.remember(key, id, true);
		} else {
			for (const key of atoms(text)) this.remember(key, 0, false);
			if (origin) {
				const id = this.addSource(origin.kind, origin.label, false);
				for (const key of shingles(normalize(text))) this.remember(key, id, true);
			}
		}
		if (!secretProblem(text)) return;
		const secretId = this.addSource("private", event.toolName, true);
		for (const line of text.split("\n")) {
			if (!secretProblem(line)) continue;
			for (const key of tokens(line)) this.remember(key, secretId, true);
			for (const key of shingles(normalize(line))) this.remember(key, secretId, true);
		}
	}

	/**
	 * Why `event` should be asked about (untrusted text in a consequential argument, private text in egress), if at all.
	 * An external prompt is skipped: its arguments lack the content its `refs` add, so `sent` checks it instead.
	 */
	check(event: ToolCallEvent, ctx: { cwd: string }): ProvenanceHit | undefined {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "externalAgent" && input.action === "prompt") return undefined;
		return this.inspect(event.toolName, input, ctx.cwd);
	}

	/**
	 * The same check for an external prompt as it is sent (`ExternalPolicy.authorize`): `text` already holds the content
	 * its `refs` expanded to, so both checks see exactly the text that leaves.
	 */
	sent(prompt: { id?: string; text?: string }, ctx: { cwd: string }): ProvenanceHit | undefined {
		return this.inspect("externalAgent", { action: "prompt", id: prompt.id, text: prompt.text }, ctx.cwd);
	}

	clear(): void {
		this.index.clear();
		this.sources.clear();
		this.cursors.clear();
		this.keys = undefined;
		this.ids = undefined;
		this.head = 0;
	}

	/** Hashes held (shingles and atoms). */
	size(): number {
		return this.index.size;
	}

	private inspect(toolName: string, input: Record<string, unknown>, cwd: string): ProvenanceHit | undefined {
		if (this.index.size === 0) return undefined;
		for (const value of this.consequential(toolName, input, cwd)) {
			const hit = this.untrustedIn(value);
			if (hit) return SHELL_TOOLS.has(toolName) ? { ...hit, why: `${hit.why}${SHELL_HINT}` } : hit;
		}
		for (const value of this.egress(toolName, input)) {
			const hit = this.privateIn(value);
			if (hit) return hit;
		}
		return undefined;
	}

	private origin(event: ToolResultEvent, cwd: string): { kind: Kind; label: string } | undefined {
		const { toolName, input } = event;
		if (toolName === "web")
			return { kind: "untrusted", label: `web ${str(input.url) ?? `search "${str(input.query) ?? ""}"`}` };
		if (toolName === "externalAgent" && input.action === "prompt")
			return { kind: "untrusted", label: `externalAgent ${str(input.id) ?? ""}`.trim() };
		// The native readers and searches, classified as `read` and `grep` were: a batch reaching any path outside the
		// workspace is private, a batch whose every query names a workspace path is trusted. Every path a query names counts
		// (`path` and an LSP `workspaceRoot`). A cursor page has the origin of the page that returned its cursor; a query
		// naming no path, or a cursor this session did not see, leaves the result an ordinary MCP one.
		if (LOCAL_TOOLS.has(toolName)) {
			const cursor = str(input.cursor);
			const inherited = cursor === undefined ? undefined : this.cursors.get(cursor);
			if (inherited !== undefined) return inherited ?? undefined;
			const queries: unknown[] = Array.isArray(input.queries) ? input.queries : [];
			const named = queries.map((query) =>
				(isRecord(query) ? [str(query.path), str(query.workspaceRoot)] : [])
					.filter((file): file is string => file !== undefined)
					.map((file) => resolveToolPath(cwd, file)),
			);
			const outside = named.flat().find((file) => !this.inWorkspace(file, cwd));
			if (outside !== undefined) return { kind: "private", label: `${toolName} ${tildePath(outside)}` };
			if (named.length > 0 && named.every((files) => files.length > 0)) return undefined;
		}
		if (isMcpToolName(toolName)) return { kind: "untrusted", label: toolName };
		if (SHELL_TOOLS.has(toolName)) {
			const command = str(input.command) ?? "";
			if (!isNetworkCommand(command)) {
				// A command that reads a file outside the workspace is private, like the native read of it.
				const shell = toolName === "powershell" || input.type === "powershell" ? "powershell" : "bash";
				const outside = outsideShellRead(command, cwd, (file) => this.inWorkspace(file, cwd), shell);
				return outside === undefined ? undefined : { kind: "private", label: `${toolName} ${tildePath(outside)}` };
			}
			const name = commandNames(command).find((program) => NETWORK.has(program.toLowerCase()));
			const url = command.match(URL_PATTERN)?.[0];
			return { kind: "untrusted", label: [toolName, name, url].filter(Boolean).join(" ") };
		}
		const target =
			toolName === "read"
				? readPaths(toolName, input, cwd)[0]
				: toolName === "grep"
					? resolveToolPath(cwd, str(input.path) ?? ".")
					: undefined;
		if (!target) return undefined;
		return this.inWorkspace(target, cwd) ? undefined : { kind: "private", label: `${toolName} ${tildePath(target)}` };
	}

	private inWorkspace(target: string, cwd: string): boolean {
		const root = this.workspaceRoot(cwd);
		return root !== undefined && isWithin(canonicalPath(target), canonicalPath(root));
	}

	/**
	 * Arguments that act: shell commands, file paths, the content of files that run or configure later sessions (or lie
	 * outside the workspace), MCP calls, memory notes. Content written into an ordinary workspace file is data.
	 */
	private consequential(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
		if (SHELL_TOOLS.has(toolName)) return [str(input.command) ?? ""];
		if (toolName === "externalAgent")
			return input.action === "connect" || input.action === "prompt" ? leaves(input) : [];
		if (toolName === "file" || toolName === "edit" || toolName === "write") {
			if (toolName === "file" && typeof input.patch === "string") return leaves(input);
			const changes = toolName === "file" ? (Array.isArray(input.queries) ? input.queries : []) : [input];
			return changes.flatMap((change) => {
				const target = isRecord(change) ? str(change.path) : undefined;
				return target && this.storesData(target, cwd) ? [target] : leaves(change);
			});
		}
		if (toolName === "archive" && archiveMutation(input)) return input.op === "set" ? leaves(input) : [];
		if (toolName === "memory") return input.op === "set" ? leaves(input) : [];
		if (isMcpToolName(toolName)) return leaves(input);
		return [];
	}

	/** `target` is an ordinary workspace file: inside the repository, not run or loaded by later sessions, not executable. */
	private storesData(target: string, cwd: string): boolean {
		const workspace = this.workspaceRoot(cwd);
		if (workspace === undefined) return false;
		const root = canonicalPath(workspace);
		const file = canonicalPath(resolveToolPath(cwd, target));
		return isWithin(file, root) && !runsLater(file, root) && !EXECUTABLE.test(file.slice(root.length));
	}

	/** Arguments that leave the machine: the web URL or search query, a browser navigation, a network command. */
	private egress(toolName: string, input: Record<string, unknown>): string[] {
		const url = str(input.url);
		if (toolName === "externalAgent" && input.action === "prompt") return [str(input.text) ?? ""];
		if (toolName === "web") return [url, str(input.query)].filter((value): value is string => value !== undefined);
		const opened = browserMcpUrls(toolName, input);
		if (opened.length > 0) return opened;
		const command = SHELL_TOOLS.has(toolName) ? str(input.command) : undefined;
		return command && isNetworkCommand(command) ? [command] : [];
	}

	private untrustedIn(value: string): ProvenanceHit | undefined {
		for (const key of atoms(value)) {
			const source = this.sourceOf(key, "untrusted");
			if (source)
				return {
					why: `contains a URL, host or e-mail first seen in ${source.label} (${formatAgo(this.now() - source.at)})`,
				};
		}
		const keys = shingles(normalize(value));
		let run = 0;
		for (const key of keys) {
			const source = this.sourceOf(key, "untrusted");
			run = source ? run + 1 : 0;
			if (source && run >= RUN)
				return { why: `contains text from ${source.label} (${formatAgo(this.now() - source.at)})` };
		}
		return undefined;
	}

	private privateIn(value: string): ProvenanceHit | undefined {
		const forms = new Set([value, decoded(value)]);
		for (const form of forms) {
			for (const key of [...tokens(form), ...shingles(normalize(form))]) {
				const source = this.sourceOf(key, "private");
				if (!source) continue;
				const when = formatAgo(this.now() - source.at);
				return {
					why: source.secret
						? `sends a secret seen in ${source.label} output (${when})`
						: `sends private text from ${source.label} (${when})`,
				};
			}
		}
		return undefined;
	}

	private sourceOf(key: number, kind: Kind): Source | undefined {
		const slot = this.index.get(key);
		const id = slot === undefined ? 0 : this.ids![slot];
		const source = id ? this.sources.get(id) : undefined;
		return source?.kind === kind ? source : undefined;
	}

	private addSource(kind: Kind, label: string, secret: boolean): number {
		const id = this.nextSource++;
		this.sources.set(id, { kind, label, secret, at: this.now() });
		if (this.sources.size > MAX_SOURCES) this.sources.delete(this.sources.keys().next().value!);
		return id;
	}

	/**
	 * Maps `key` to source `id` in the next ring slot, evicting the hash that slot held (the oldest). A shingle seen
	 * again moves to the newest source and becomes youngest; an atom keeps the source it was first seen in.
	 */
	private remember(key: number, id: number, refresh: boolean): void {
		if (!refresh && this.index.has(key)) return;
		this.keys ??= new Float64Array(this.maxShingles);
		const keys = this.keys;
		this.ids ??= new Int32Array(this.maxShingles);
		const ids = this.ids;
		const slot = this.head;
		this.head = (slot + 1) % this.maxShingles;
		// An empty slot holds id 0 and key 0; a stale slot (its hash since moved) no longer owns the hash.
		if (this.index.get(keys[slot]) === slot) this.index.delete(keys[slot]);
		keys[slot] = key;
		ids[slot] = id;
		this.index.set(key, slot);
	}
}

/** The session's provenance index: `record` from `tool_result`, `check` in the permission gate, `clear` on `session_start`. */
export function createProvenance(options: ProvenanceOptions = {}): Provenance {
	return new Provenance(options);
}
