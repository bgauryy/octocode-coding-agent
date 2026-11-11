import type { Db } from "../../../../db/src/api.ts";
import { processSamples } from "../../../../db/src/api.ts";
import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { type Subcommand, say } from "../shared/commands.ts";
import { plural } from "../shared/text.ts";
import { type Orphan, type ProcessReport, classifyProcesses } from "./classify.ts";
import { formatReport } from "./format.ts";
import { SAMPLE_RETENTION_MS } from "./sampler.ts";
import { stopOrphans, type StopDeps } from "./stop.ts";
import type { ProcessTableSource } from "./table.ts";

export interface ProcessesCommandOptions {
	db: () => Db;
	table: ProcessTableSource;
	match: StopDeps["match"];
	stop: StopDeps["stop"];
	now?: () => number;
	/** The running API instances: which pid can be reached, and by what id. */
	apiInstances?: () => ReadonlyArray<{ id: string; pid: number }>;
}

const USAGE = "Usage: /processes [stop]";

/**
 * `/processes`: the Octocode processes on this machine (main sessions, subagents, RPC hosts) with the MCP servers and bash
 * jobs each owns, flagging orphans and memory that keeps growing; `/processes stop` stops the orphans after a
 * confirmation. It reads the process table and every process's samples (`processSamples`), so what another session
 * recorded about its children is visible here.
 */
export function processesCommand(options: ProcessesCommandOptions): Subcommand {
	const now = options.now ?? Date.now;
	const report = async (): Promise<ProcessReport | undefined> => {
		const table = await options.table();
		if (!table) return undefined;
		const samples = processSamples.since(options.db(), now() - SAMPLE_RETENTION_MS);
		const apiIds = new Map(options.apiInstances?.().map(({ id, pid }) => [pid, id]));
		return classifyProcesses({ table, samples, now: now(), selfPid: process.pid, apiIds });
	};

	const stop = async (ctx: ExtensionCommandContext, orphans: readonly Orphan[]): Promise<void> => {
		if (orphans.length === 0) return say(ctx, "No orphans to stop.");
		// Signalling processes needs a person at a prompt: print, JSON and subagent runs have none.
		if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json")
			return say(ctx, "/processes stop asks for confirmation, so it needs an interactive session.", "warning");
		const lines = orphans.map((orphan) => `pid ${orphan.pid} · ${orphan.kind} · ${orphan.label}`);
		const confirmed = await ctx.ui.confirm(
			`Stop ${plural(orphans.length, "orphaned process", "orphaned processes")}?`,
			`${lines.join("\n")}\n\nEach gets SIGTERM, then SIGKILL if it is still running after a short grace period.`,
		);
		if (!confirmed) return say(ctx, "Nothing stopped.");
		const results = await stopOrphans(orphans, {
			current: async () => (await report())?.orphans ?? [],
			match: options.match,
			stop: options.stop,
		});
		say(
			ctx,
			results
				.map((result) => `${result.outcome} pid ${result.pid} (${result.label})${result.why ? `: ${result.why}` : ""}`)
				.join("\n"),
			results.every((result) => result.outcome === "stopped") ? "info" : "warning",
		);
	};

	return {
		description: "List or stop Octocode processes and orphans",
		argumentHint: "[stop]",
		handler: async (args, ctx) => {
			if (args !== "" && args !== "stop") return say(ctx, USAGE, "warning");
			const current = await report();
			if (!current)
				return say(ctx, "The process table cannot be read here (it needs `ps`, which Windows lacks).", "warning");
			if (args === "stop") return stop(ctx, current.orphans);
			say(ctx, formatReport(current), current.orphans.length ? "warning" : "info");
		},
		complete: (prefix) =>
			"stop".startsWith(prefix)
				? [{ value: "stop", label: "stop", description: "stop orphaned processes (asks first)" }]
				: null,
	};
}
