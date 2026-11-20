import type { Db } from "../../../../db/src/api.ts";
import { processSamples } from "../../../../db/src/api.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { cancelledText, type Subcommand, say } from "../shared/commands.ts";
import { plural } from "../shared/text.ts";
import { type Orphan, type ProcessReport, classifyProcesses } from "./classify.ts";
import { formatReport } from "./format.ts";
import { SAMPLE_RETENTION_MS } from "./sampler.ts";
import { scopeToSession } from "./scope.ts";
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

const USAGE = "Usage: /processes [all|stop]";

/**
 * `/processes`: this session's process and its subagents with the MCP servers and bash jobs each owns, flagging
 * orphans and memory that keeps growing; `/processes all` lists every Octocode process on the machine (other sessions,
 * RPC hosts); `/processes stop` stops the orphans after a confirmation. It reads the process table and every process's samples (`processSamples`), so what another session
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

	const stop = async (ctx: CommandContext, orphans: readonly Orphan[]): Promise<void> => {
		if (orphans.length === 0) return say(ctx, "No orphans to stop.");
		// Signalling processes needs a person at a prompt: print, JSON and subagent runs have none.
		if (!ctx.hasUI || ctx.mode === "print" || ctx.mode === "json")
			return say(ctx, "/processes stop asks for confirmation, so it needs an interactive session.", "warning");
		const lines = orphans.map((orphan) => `pid ${orphan.pid} · ${orphan.kind} · ${orphan.label}`);
		const confirmed = await ctx.ui.confirm(
			`Stop ${plural(orphans.length, "orphaned process", "orphaned processes")}?`,
			`${lines.join("\n")}\n\nEach gets SIGTERM, then SIGKILL if it is still running after a short grace period.`,
		);
		if (!confirmed) return say(ctx, cancelledText("stopped"));
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
		argumentHint: "[all|stop]",
		handler: async (args, ctx) => {
			if (args !== "" && args !== "all" && args !== "stop") return say(ctx, USAGE, "warning");
			const current = await report();
			if (!current)
				return say(ctx, "The process table cannot be read here (it needs `ps`, which Windows lacks).", "warning");
			if (args === "stop") return stop(ctx, current.orphans);
			// A terminal wraps at its width, so rows are laid out for it; other modes get the full table.
			const width = ctx.mode === "tui" && process.stdout.columns ? process.stdout.columns - 2 : undefined;
			const shown = args === "all" ? { report: current, hidden: 0 } : scopeToSession(current, process.pid);
			say(
				ctx,
				formatReport(shown.report, { width, hidden: shown.hidden }),
				current.orphans.length ? "warning" : "info",
			);
		},
		complete: (prefix) => {
			const options = [
				{ value: "all", label: "all", description: "every Octocode process on this machine" },
				{ value: "stop", label: "stop", description: "stop orphaned processes (asks first)" },
			].filter((option) => option.value.startsWith(prefix));
			return options.length ? options : null;
		},
	};
}
