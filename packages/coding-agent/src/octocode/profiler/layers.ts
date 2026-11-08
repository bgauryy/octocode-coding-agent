import type { ProfileLayerKind } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { num, str, sha, type Entry, type Prepared } from "./entries.ts";

/** One layer of a request before tokens and cache states are assigned. */
export interface Draft {
	kind: ProfileLayerKind;
	label: string;
	/** Size of the layer; tokens are chars / 4, scaled to the provider's total. Zero for a marker. */
	chars: number;
	/** What identifies the layer's content: a recorded hash (exact) or an entry id / text hash (estimated). */
	key: string;
	breakpoint?: boolean;
	entry?: number;
	/** Set by the comparison with the previous request. */
	changed?: boolean;
	broke?: boolean;
}

export interface RequestLayers {
	drafts: Draft[];
	/** Index of the first history layer (after tools and system). */
	historyStart: number;
	estimated: boolean;
}

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

interface Head {
	base?: string;
	sections: Map<string, string>;
	extras: string[];
	tools: Map<string, string>;
}

/** Replays the system messages on the path: the leading one sets the prompt, later ones update it in place. */
function replayHead(path: Entry[]): Head {
	const head: Head = { sections: new Map(), extras: [], tools: new Map() };
	for (const entry of path) {
		const message = asRecord(entry.message);
		if (entry.type !== "message" || message.role !== "system") continue;
		const content = text(message.content);
		if (head.base === undefined) head.base = content;
		else if (content) head.extras.push(content);
		for (const [name, body] of Object.entries(asRecord(message.sections)))
			if (typeof body === "string") head.sections.set(name, body);
			else head.sections.delete(name);
		for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : [])
			head.tools.set(str(asRecord(tool).name, String(head.tools.size)), JSON.stringify(tool));
		for (const ref of Array.isArray(message.toolsRemoved) ? message.toolsRemoved : [])
			head.tools.delete(typeof ref === "string" ? ref : String(asRecord(ref).name));
	}
	return head;
}

function headDrafts(head: Head): Draft[] {
	const drafts: Draft[] = [];
	if (head.tools.size) {
		const all = [...head.tools.values()].join("");
		drafts.push({ kind: "tools", label: `tools (${head.tools.size})`, chars: all.length, key: sha(all) });
	}
	if (head.base !== undefined)
		drafts.push({ kind: "system", label: "system", chars: head.base.length, key: sha(head.base) });
	for (const [name, body] of head.sections)
		drafts.push({ kind: "system", label: name, chars: body.length, key: sha(body) });
	head.extras.forEach((body, i) =>
		drafts.push({ kind: "system", label: `instructions update ${i + 1}`, chars: body.length, key: sha(body) }),
	);
	return drafts;
}

/** Interrupt reasons are free text; only a short identifier-like reason is shown. */
function interruptLabel(entry: Entry): string {
	const reason = asRecord(entry.data).reason;
	return typeof reason === "string" && /^[a-z][a-z_-]{0,23}$/.test(reason) ? `interrupt: ${reason}` : "interrupt";
}

/** The layer a history entry puts into the next request, or undefined when the model never sees it. */
function historyDraft(entry: Entry, position: number): Draft | undefined {
	const base = { key: `${entry.type}:${entry.id}`, entry: position };
	const message = asRecord(entry.message);
	switch (entry.type) {
		case "message": {
			const chars = text(message.content).length;
			if (message.role === "user") {
				const origin = str(entry.origin ?? message.origin, "typed");
				if (origin === "steer" || origin === "follow-up") return { ...base, kind: "steer", label: origin, chars };
				return { ...base, kind: "message", label: origin === "typed" ? "user" : `user (${origin})`, chars };
			}
			if (message.role === "assistant") return { ...base, kind: "message", label: "assistant", chars };
			if (message.role === "toolResult")
				return { ...base, kind: "tool-result", label: str(message.toolName, "tool").slice(0, 60), chars };
			if (message.role === "bashExecution" && message.excludeFromContext !== true)
				return { ...base, kind: "message", label: "bash", chars };
			return undefined;
		}
		case "custom_message":
			return {
				...base,
				kind: "notice",
				label: str(entry.customType, "notice").slice(0, 60),
				chars: text(entry.content).length,
			};
		case "compaction":
		case "branch_summary":
			return {
				...base,
				kind: "summary",
				label: entry.type === "compaction" ? "compaction summary" : "branch summary",
				chars: text(entry.summary).length,
			};
		case "custom":
			return entry.customType === "octocode-interrupt"
				? { ...base, kind: "interrupt", label: interruptLabel(entry), chars: 0 }
				: undefined;
	}
	return undefined;
}

/** The entries from the root to `position` along parent links (file order when entries carry none). */
function pathTo(prepared: Prepared, position: number): number[] {
	const { entries, byId } = prepared;
	const chain: number[] = [];
	const seen = new Set<number>();
	let at: number | undefined = position;
	while (at !== undefined && !seen.has(at)) {
		seen.add(at);
		chain.push(at);
		const parent: unknown = entries[at].parentId;
		at = typeof parent === "string" ? byId.get(parent) : undefined;
	}
	return chain.reverse();
}

/** What the context holds after a compaction: its summary, then the entries from the first kept one. */
function history(prepared: Prepared, chain: number[]): Draft[] {
	let drafts: Array<Draft & { at: number }> = [];
	for (const [at, position] of chain.entries()) {
		const entry = prepared.entries[position];
		const draft = historyDraft(entry, position);
		if (entry.type === "compaction") {
			// The context opens with the summary, then the kept entries (`buildSessionContext`).
			const kept = chain.findIndex((p) => prepared.entries[p].id === entry.firstKeptEntryId);
			drafts = [...(draft ? [{ ...draft, at }] : []), ...drafts.filter((each) => kept >= 0 && each.at >= kept)];
			continue;
		}
		if (draft) drafts.push({ ...draft, at });
	}
	return drafts.map((each) => {
		const draft: Draft & { at?: number } = { ...each };
		delete draft.at;
		return draft;
	});
}

/** The layers a request sent, from the layers the recording side stored with it. */
function traceDrafts(trace: Record<string, unknown>, head: Head, past: Draft[]): Draft[] | undefined {
	const layers = Array.isArray(trace.layers) ? trace.layers.map(asRecord) : [];
	if (!layers.length) return undefined;
	const names = headDrafts({ ...head, tools: new Map() }).map((draft) => draft.label);
	const wire = layers.filter((layer) => layer.kind === "message").length;
	const join = wire === past.length;
	let systems = 0;
	let messages = 0;
	return layers.map((layer): Draft => {
		const chars = num(layer.chars);
		const key = str(layer.hash, "");
		const breakpoint = layer.breakpoint === true ? { breakpoint: true } : {};
		if (layer.kind === "tools")
			return { kind: "tools", label: `tools (${head.tools.size})`, chars, key, ...breakpoint };
		if (layer.kind === "system")
			return { kind: "system", label: names[systems++] ?? `system ${systems}`, chars, key, ...breakpoint };
		const joined = join ? past[messages] : undefined;
		messages++;
		const role = str(layer.role, "message");
		return { ...(joined ?? { kind: "message", label: role }), chars, key, ...breakpoint };
	});
}

/** The tool definitions (name to JSON) the transcript says were active for the request at `position`. */
export function toolDefinitions(prepared: Prepared, position: number): Map<string, string> {
	return replayHead(pathTo(prepared, position).map((p) => prepared.entries[p])).tools;
}

/** The layers of the request the assistant entry at `position` answered; exact when the entry recorded its trace. */
export function requestLayers(prepared: Prepared, position: number): RequestLayers {
	const chain = pathTo(prepared, position).slice(0, -1);
	const path = chain.map((p) => prepared.entries[p]);
	const head = replayHead(path);
	const past = history(prepared, chain);
	const trace = asRecord(asRecord(prepared.entries[position].message).requestTrace);
	const exact = traceDrafts(trace, head, past);
	if (exact) {
		const start = exact.findIndex((draft) => draft.kind !== "tools" && draft.kind !== "system");
		return { drafts: exact, historyStart: start < 0 ? exact.length : start, estimated: false };
	}
	const drafts = headDrafts(head);
	return { drafts: [...drafts, ...past], historyStart: drafts.length, estimated: true };
}
