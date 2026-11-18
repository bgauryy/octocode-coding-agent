/**
 * Tool changes a transport cannot carry without rewriting its cached tool list. Where the model's transport has no
 * in-place tool changes (`none`) or no removals (`additions`), a tool switched off mid-span stays declared and its calls
 * are refused; on `none`, a tool switched on that the transcript never declared, an MCP server's tools connecting
 * mid-session too, is callable but declared only at the next span (the prompt's on-demand index line names it
 * meanwhile, and a server's `mcps` block lists its tools). A span ends at a compaction, at a model switch (the
 * new model has no cache to keep), or when the loadout is restored.
 */

import { getToolLoadingMode, type ToolLoadingMode } from "@octocodeai/octocode-ai/utils/tool-loading";
import { getCurrentTools } from "@octocodeai/octocode-ai";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { renderPrompt } from "../../prompt-template.ts";

/** Alternatives named by a refusal: the active tools of the same namespace, else the first few listed active tools. */
const MAX_ALTERNATIVES = 4;

export interface HeldToolsHost {
	/** The session model, whose transport decides what is held. */
	model(): Model<any> | undefined;
	/** The tool names the transcript declares now. */
	declared(): ReadonlySet<string>;
	namespaceOf(name: string): string | undefined;
}

export class HeldTools {
	/** Switched off, still declared: calls are refused until the next span drops the declaration. */
	private readonly _off = new Set<string>();
	/** Switched on, callable, not declared until the next span (never an MCP tool). */
	private readonly _late = new Set<string>();
	private _span: string | undefined;
	/** The next change is a span boundary: it applies whole, with nothing held back. */
	private _release = false;
	/** The declarations the `prepareLoadout` hooks hid at the last change. */
	private _hidden: ReadonlySet<string> = new Set();

	private readonly host: HeldToolsHost;

	constructor(host: HeldToolsHost) {
		this.host = host;
	}

	get off(): ReadonlySet<string> {
		return this._off;
	}

	get late(): ReadonlySet<string> {
		return this._late;
	}

	private mode(): ToolLoadingMode {
		const model = this.host.model();
		return model ? getToolLoadingMode(model) : "changes";
	}

	/** Record that the active tools went from `previous` to `next`; returns `hidden` plus the late tools. */
	apply(previous: readonly string[], next: readonly string[], hidden: ReadonlySet<string>): ReadonlySet<string> {
		this.change(previous, next);
		this._hidden = hidden;
		return new Set([...hidden, ...this._late]);
	}

	/**
	 * What a request in the span after `compaction` leaves out: the last `hidden` plus the late tools. A new compaction,
	 * on whichever path it ran (before a prompt, inside a run, after an overflow), declares the late tools on its own
	 * request, whose messages are rewritten anyway.
	 */
	hiddenIn(compaction: string | undefined): ReadonlySet<string> {
		this.beginSpan(compaction);
		return new Set([...this._hidden, ...this._late]);
	}

	private change(previous: readonly string[], next: readonly string[]): void {
		const mode = this.mode();
		if (mode === "changes" || this._release) {
			this._release = false;
			this.clear();
			return;
		}
		const declared = this.host.declared();
		const active = new Set(next);
		const before = new Set(previous);
		for (const name of this._off) if (active.has(name)) this._off.delete(name);
		for (const name of before) {
			if (active.has(name)) continue;
			this._late.delete(name);
			if (declared.has(name)) this._off.add(name);
		}
		if (mode === "none" && declared.size > 0)
			for (const name of next) if (!before.has(name) && !declared.has(name)) this._late.add(name);
	}

	/** Make the next change a span boundary, as a feature's own `setActiveTools` asks: it reaches the next request. */
	releaseNext(): void {
		this._release = true;
	}

	/** The span the transcript is in, named by its last compaction and the model; a new one drops every held change. */
	beginSpan(compaction: string | undefined): void {
		const model = this.host.model();
		const span = `${compaction ?? ""}|${model ? `${model.provider}/${model.id}` : ""}`;
		if (span === this._span) return;
		this._span = span;
		this.clear();
	}

	clear(): void {
		this._off.clear();
		this._late.clear();
	}

	private alternatives(name: string, active: readonly string[]): string {
		const namespace = this.host.namespaceOf(name);
		const others = active.filter((other) => other !== name && !this._off.has(other));
		const siblings = namespace ? others.filter((other) => this.host.namespaceOf(other) === namespace) : [];
		return (siblings.length > 0 ? siblings : others.filter((other) => !this.host.namespaceOf(other)))
			.slice(0, MAX_ALTERNATIVES)
			.join(", ");
	}

	/** The error text for a call to an off tool, after `Tool <name> not found: `; undefined for any other tool. */
	refusal(name: string, active: readonly string[]): string | undefined {
		return this._off.has(name)
			? renderPrompt("notices/tool-off-refused.md", { alternatives: this.alternatives(name, active) })
			: undefined;
	}

	/** The announcement section while tools are off, which the next span removes; undefined when none is. */
	notice(active: readonly string[]): string | undefined {
		if (this._off.size === 0) return undefined;
		const alternatives = [...new Set([...this._off].flatMap((name) => this.alternatives(name, active).split(", ")))];
		return renderPrompt("notices/tool-off.md", {
			names: [...this._off].join(", "),
			several: this._off.size > 1,
			alternatives: alternatives.filter(Boolean).slice(0, MAX_ALTERNATIVES).join(", "),
		});
	}
}

/** The span a transcript is in: its last compaction, or undefined before any. */
export function spanOf(messages: readonly { role: string; timestamp?: number }[]): string | undefined {
	const last = messages.findLast((message) => message.role === "compactionSummary");
	return last ? String(last.timestamp ?? 0) : undefined;
}

/** Held tools for a session: its model, the transcript's declarations and tool namespaces. */
export function heldToolsFor(
	session: () => { model: Model<any> | undefined; agent: { state: { messages: readonly { role: string }[] } } },
	namespaceOf: (name: string) => string | undefined,
): HeldTools {
	return new HeldTools({
		model: () => session().model,
		declared: () => new Set(getCurrentTools(session().agent.state.messages).map((tool) => tool.name)),
		namespaceOf,
	});
}

/** `sections` with the off-tools announcement set while a tool is off and removed once none is. */
export function withToolsOffNotice(
	sections: Record<string, string>,
	notice: string | undefined,
): Record<string, string> {
	const { tools_off: _previous, ...others } = sections;
	return notice ? { ...others, tools_off: notice } : others;
}
