import type { ToolCallEvent, ToolResultEvent } from "../../core/features/index.ts";
import { formatAgo } from "../shared/format.ts";
import { readPaths, resolveToolPath } from "../shared/home.ts";
import { homeTilde } from "../../../../common/src/home-tilde.ts";
import { isWorkspaceReader, readerLocations } from "../shared/local-reads.ts";
import { secretProblem } from "../../../../common/src/sanitize.ts";
import { contentText } from "../shared/util.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../common/src/paths.ts";
import { workspaceRoot } from "../../utils/git-repository.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { archiveRead } from "../shared/archive-operation.ts";
import { KeyTable } from "./key-table.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { type AllowedSource, type CheckContext, type IgnorableScope, maskIgnorable } from "./provenance/ignorable.ts";
import { untrustedResultOrigin } from "./result-origin.ts";
import { atoms, capBytes, decoded, normalize, RUN, shingles, tokens } from "./provenance/keys.ts";
import { outsideShellRead } from "./provenance/shell-reads.ts";
import { consequential, egress, leaves, str } from "./provenance/arguments.ts";

/** What a hit on a shell command adds: saving quoted material as data is fine, running it is the risk. */
const SHELL_HINT = "; to save quoted material, write it as data with the `file` tool, not a shell command";

/**
 * A CaMeL-inspired provenance tripwire: tool outputs are tagged by where they came from, and a later call
 * whose arguments repeat them is flagged. `untrusted` output (web, browser, MCP, network commands, a subagent's report) reaching a
 * consequential argument (a shell command, file content, an MCP call, a memory, a subagent's task) and `private` output (reads
 * outside the workspace, secret-looking lines) reaching an egress argument (a URL, a network command) are hits.
 * Workspace reads, by the reader and search roles of trusted MCP entries as by the legacy `read` and `grep`, are trusted.
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

type Kind = "untrusted" | "private";
interface Source {
	kind: Kind;
	/** The tool and where its output came from: `web https://…`, `read ~/…`, `bash curl https://…`. */
	label: string;
	secret: boolean;
	at: number;
	/** The subagent whose report this is, for a source that is one. */
	agent?: string;
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
	/** The subagent the text came from, when it came from one: what a session grant of that source names. */
	agent?: string;
}

class Provenance {
	/** Hash → its slot in the ring below. */
	private readonly index: KeyTable;
	/** Oldest-first eviction: `keys[slot]` is the hash written there, `ids[slot]` its source (0: an atom first seen in trusted output). */
	private keys: Float64Array | undefined;
	private ids: Int32Array | undefined;
	private head = 0;
	private readonly sources = new Map<number, Source>();
	/** A local tool's cursor → the origin of the page that returned it (null: trusted), so the next page inherits it. */
	private readonly cursors = new Map<string, { kind: Kind; label: string; agent?: string } | null>();
	private nextSource = 1;
	/** Some source read here is outside what a workspace read trusts: what a parent needs to know of its child. */
	private exposure = false;
	/** Children their own run reported as having read nothing untrusted: their reports are indexed as nothing. */
	private readonly cleanChildren = new Set<string>();
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
		if (isWorkspaceReader(event.toolName))
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
			const id = this.addSource(origin.kind, origin.label, false, origin.agent);
			for (const key of atoms(text)) if (!echoed.has(key)) this.remember(key, id, false);
			for (const key of shingles(normalize(text))) if (!echoed.has(key)) this.remember(key, id, true);
		} else {
			for (const key of atoms(text)) this.remember(key, 0, false);
			if (origin) {
				const id = this.addSource(origin.kind, origin.label, false, origin.agent);
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
	check(event: ToolCallEvent, ctx: CheckContext, allowed?: AllowedSource): ProvenanceHit | undefined {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "externalAgent" && input.action === "prompt") return undefined;
		return this.inspect(event.toolName, input, ctx, allowed);
	}

	/**
	 * The same check for an external prompt as it is sent (`ExternalPolicy.authorize`): `text` already holds the content
	 * its `refs` expanded to, so both checks see exactly the text that leaves.
	 */
	sent(prompt: { id?: string; text?: string }, ctx: CheckContext, allowed?: AllowedSource): ProvenanceHit | undefined {
		return this.inspect("externalAgent", { action: "prompt", id: prompt.id, text: prompt.text }, ctx, allowed);
	}

	clear(): void {
		this.index.clear();
		this.sources.clear();
		this.cursors.clear();
		this.cleanChildren.clear();
		this.exposure = false;
		this.keys = undefined;
		this.ids = undefined;
		this.head = 0;
	}

	/** Hashes held (shingles and atoms). */
	size(): number {
		return this.index.size;
	}

	private inspect(
		toolName: string,
		input: Record<string, unknown>,
		ctx: CheckContext,
		allowed: AllowedSource | undefined,
	): ProvenanceHit | undefined {
		if (this.index.size === 0) return undefined;
		const { cwd } = ctx;
		for (const value of consequential(toolName, input, cwd, this.workspaceRoot)) {
			const hit = this.untrustedIn(value, this.scope(ctx), allowed);
			if (hit) return SHELL_TOOLS.has(toolName) ? { ...hit, why: `${hit.why}${SHELL_HINT}` } : hit;
		}
		for (const value of egress(toolName, input)) {
			const hit = this.privateIn(value);
			if (hit) return hit;
		}
		return undefined;
	}

	private origin(event: ToolResultEvent, cwd: string): { kind: Kind; label: string; agent?: string } | undefined {
		const { toolName, input } = event;
		const external = untrustedResultOrigin(toolName, input, event.details, { requireRan: false });
		if (toolName === "web" && external !== undefined) return { kind: "untrusted", label: external };
		if (toolName === "externalAgent" && input.action === "prompt")
			return { kind: "untrusted", label: `externalAgent ${str(input.id) ?? ""}`.trim() };
		// A child reads web pages and repositories of its own, and its index dies with its process: what it reports here is
		// untrusted however it was worded, or text from a page would come back clean through a subagent.
		// Unless that child reported, on the channel only its own harness writes to, that it read nothing untrusted.
		if (toolName === "agent") {
			const child = isRecord(event.details) ? str(event.details.id) : undefined;
			if (child !== undefined && this.cleanChildren.has(child)) return undefined;
			return {
				kind: "untrusted",
				label: `agent ${child ?? str(input.profile) ?? ""}`.trim(),
				...(child ? { agent: child } : {}),
			};
		}
		// Reader and search roles, classified as `read` and `grep` were: input naming any location outside the workspace is
		// private; input whose every request names a workspace location is trusted. A cursor page has the origin of the page
		// that returned its cursor; input naming no location, or a cursor this session did not see, leaves the result an
		// ordinary MCP one.
		if (isWorkspaceReader(toolName)) {
			const cursor = str(input.cursor);
			const inherited = cursor === undefined ? undefined : this.cursors.get(cursor);
			if (inherited !== undefined) return inherited ?? undefined;
			const { files, unnamed } = readerLocations(input);
			const named = files.map((file) => resolveToolPath(cwd, file));
			const outside = named.find((file) => !this.inWorkspace(file, cwd));
			if (outside !== undefined) return { kind: "private", label: `${toolName} ${homeTilde(outside)}` };
			if (named.length > 0 && !unnamed) return undefined;
		}
		if (toolName === "archive" && readsSessionText(input)) return { kind: "untrusted", label: "archive" };
		if (external !== undefined && !SHELL_TOOLS.has(toolName)) return { kind: "untrusted", label: external };
		if (SHELL_TOOLS.has(toolName)) {
			const command = str(input.command) ?? "";
			if (external === undefined) {
				// A command that reads a file outside the workspace is private, like the native read of it.
				const shell = toolName === "powershell" || input.type === "powershell" ? "powershell" : "bash";
				const outside = outsideShellRead(command, cwd, (file) => this.inWorkspace(file, cwd), shell);
				return outside === undefined ? undefined : { kind: "private", label: `${toolName} ${homeTilde(outside)}` };
			}
			return { kind: "untrusted", label: external };
		}
		const target =
			toolName === "read"
				? readPaths(toolName, input, cwd)[0]
				: toolName === "grep"
					? resolveToolPath(cwd, str(input.path) ?? ".")
					: undefined;
		if (!target) return undefined;
		return this.inWorkspace(target, cwd) ? undefined : { kind: "private", label: `${toolName} ${homeTilde(target)}` };
	}

	private inWorkspace(target: string, cwd: string): boolean {
		const root = this.workspaceRoot(cwd);
		return root !== undefined && isWithin(canonicalPath(target), canonicalPath(root));
	}

	private untrustedIn(value: string, scope: () => IgnorableScope, allowed?: AllowedSource): ProvenanceHit | undefined {
		// A source the user allowed for the session (a subagent) is skipped; any other source in the same text still hits.
		const found = (key: number): Source | undefined => {
			const source = this.sourceOf(key, "untrusted");
			return source?.agent !== undefined && allowed?.(source.agent) ? undefined : source;
		};
		const named = (source: Source): { agent?: string } => (source.agent ? { agent: source.agent } : {});
		for (const key of atoms(value)) {
			const source = found(key);
			if (source)
				return {
					why: `contains a URL, host or e-mail first seen in ${source.label} (${formatAgo(this.now() - source.at)})`,
					...named(source),
				};
		}
		const run = (text: string): ProvenanceHit | undefined => {
			let length = 0;
			for (const key of shingles(normalize(text))) {
				const source = found(key);
				length = source ? length + 1 : 0;
				if (source && length >= RUN)
					return { why: `contains text from ${source.label} (${formatAgo(this.now() - source.at)})`, ...named(source) };
			}
			return undefined;
		};
		const hit = run(value);
		if (!hit) return undefined;
		// Only now, as a hit is rare: text that is only a workspace path, the cwd or a model id is no hit.
		const masked = maskIgnorable(value, scope());
		return masked === value ? hit : run(masked);
	}

	private scope(ctx: CheckContext): () => IgnorableScope {
		return () => ({
			cwd: ctx.cwd,
			root: this.workspaceRoot(ctx.cwd),
			models: ctx.modelRegistry?.getAll() ?? [],
		});
	}

	/** Whether any source read in this session was one a workspace read does not vouch for (web, MCP, a network command, an outside file). */
	exposed(): boolean {
		return this.exposure;
	}

	/**
	 * What a child's own run reported, through the channel only its harness writes to (`provenance/exposure.ts`): a child that
	 * read nothing untrusted is clean and its report is indexed as nothing; any other state, and a child never heard from,
	 * is untrusted.
	 */
	childExposure(child: string, exposed: boolean): void {
		if (exposed) this.cleanChildren.delete(child);
		else this.cleanChildren.add(child);
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

	private addSource(kind: Kind, label: string, secret: boolean, agent?: string): number {
		const id = this.nextSource++;
		if (!secret) this.exposure = true;
		this.sources.set(id, { kind, label, secret, at: this.now(), ...(agent ? { agent } : {}) });
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

/**
 * An archive read whose results can hold another session's transcript text (sessions and compactions, which `all` and the
 * default include): that session read web pages and tool output of its own. Agents and events are this workspace's
 * records. A recorded call that named a memory (`M<n>`, before `memory` became its own tool) is refused, so it is clean.
 */
function readsSessionText(input: Record<string, unknown>): boolean {
	if (!archiveRead(input)) return false;
	const source = str(input.source);
	if (source !== undefined) return source === "all" || source === "sessions" || source === "compactions";
	return !/^M\d+$/.test(str(input.id) ?? "");
}
