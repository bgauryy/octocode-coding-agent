import type { ToolDisplay, ToolDisplayBlock } from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ToolDisplayInput } from "../../core/features/types.ts";
import { formatDuration } from "../../utils/duration.ts";
import { plural } from "../../../../common/src/clip.ts";
import { pathBlock } from "../shared/display.ts";
import { fileChanges } from "../shared/file-input.ts";
import { bashOutcome, diffStats, querySize, type BashDetails, type QueryOutcome } from "./outcome.ts";

/** The text blocks of a result, joined. */
const contentText = (content: ReadonlyArray<{ type: string; text?: string }>) =>
	content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");

type BashArgs = { command?: string; timeout?: number; background?: boolean; type?: string };

/** `Bash(npm test) · background` / `⎿ exit 1 · 12 lines`, the command output, notices and the saved output path. */
export function bashDisplay({
	args,
	result,
	status,
}: ToolDisplayInput<BashArgs, BashDetails | undefined>): ToolDisplay {
	const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
	const meta = [args.background ? "background" : "", asked ? `timeout ${formatDuration(asked * 1000)}` : ""].filter(
		Boolean,
	);
	const command = typeof args.command === "string" ? args.command : "";
	const head: ToolDisplay = {
		title: args.type === "powershell" ? "PowerShell" : "Bash",
		...(command ? { summary: command } : {}),
		...(meta.length ? { meta } : {}),
		kind: "execute",
		blocks: [],
	};
	if (!result) return head;
	const details: BashDetails = result.details ?? {};
	const failed = status === "failed";
	const notices: ToolDisplayBlock[] = (details.notices ?? []).map((notice) => ({
		type: "text",
		text: notice,
		tone: "muted",
	}));
	if (details.job && !failed)
		return {
			...head,
			outcome: {
				text: `job ${details.job} ${details.moved ? "moved to the background" : "started"} (pid ${details.pid ?? "?"})`,
			},
			blocks: [...notices, ...pathBlock(details.log, "log")],
		};
	const outcome = bashOutcome(contentText(result.content), failed, status === "running", undefined, details);
	const spill = details.fullOutputPath ?? outcome.spill;
	const stopped = details.termination === "aborted" || details.termination === "terminated";
	return {
		...head,
		outcome: {
			text: outcome.summary,
			...(failed ? { tone: "error" as const } : {}),
			...(failed && stopped ? { stopped: true as const } : {}),
		},
		blocks: [
			...(outcome.body
				? [
						{
							type: "output",
							text: outcome.body,
							...(command ? { command } : {}),
							...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
							...(details.termination === "timeout" ? { timedOut: true as const } : {}),
						},
					]
				: []),
			...notices,
			...pathBlock(spill),
		],
	};
}

type FileQuery = {
	type?: string;
	path?: string;
	movePath?: string;
	reason?: string;
	edits?: unknown[];
	content?: string;
};

const describe = (query: FileQuery | undefined) =>
	`${query?.type ?? "…"} ${query?.path ?? ""}${query?.movePath ? ` → ${query.movePath}` : ""}${querySize(query)}`;

/** `File(edit a.ts · 2 edits)` / per-file `+a -r` and the unified diff; failed changes listed with their message. */
export function fileDisplay({ args, result, status }: ToolDisplayInput<Record<string, unknown>, unknown>): ToolDisplay {
	const queries = fileChanges(args ?? {}) as FileQuery[];
	const locations = queries.flatMap((query) => (query.path ? [{ path: query.movePath ?? query.path }] : []));
	const head: ToolDisplay = {
		title: "File",
		...(queries.length === 1
			? { summary: describe(queries[0]) }
			: queries.length > 1
				? { summary: `${queries.length} changes` }
				: {}),
		...(queries.length > 1 ? { subjects: queries.map(describe) } : {}),
		kind: "edit",
		...(locations.length ? { locations } : {}),
		blocks: [],
	};
	if (!result) return head;
	const outcomes = (
		isRecord(result.details) && Array.isArray(result.details.outcomes) ? result.details.outcomes : []
	) as QueryOutcome[];
	if (outcomes.length === 0) {
		// Every change failed: the tool threw with the numbered outcome list.
		const [summary = "", ...rest] = contentText(result.content)
			.split("\n")
			.map((line) => line.replace(/^\d+\. FAILED /, ""));
		return {
			...head,
			outcome: { text: summary, ...(status === "failed" ? { tone: "error" as const } : {}) },
			blocks: rest.join("\n").trim() ? [{ type: "text", text: rest.join("\n") }] : [],
		};
	}
	const files = outcomes
		.filter((outcome) => outcome.ok && outcome.diff)
		.map((outcome) => {
			const stats = diffStats(outcome.diff!);
			const operation =
				outcome.type === "delete"
					? ("delete" as const)
					: outcome.type === "write" && outcome.receipt?.beforeDigest === null
						? ("add" as const)
						: ("modify" as const);
			return { path: outcome.path, operation, additions: stats.added, removals: stats.removed, patch: outcome.diff! };
		});
	const failures = outcomes.filter((outcome) => !outcome.ok);
	const applied = outcomes.length - failures.length;
	const blocks: ToolDisplayBlock[] = [];
	if (files.length)
		blocks.push({
			type: "diff",
			text: files.map((file) => `${file.path} +${file.additions} -${file.removals}\n${file.patch}`).join("\n"),
			files,
		});
	if (failures.length)
		blocks.push({
			type: "list",
			text: failures.map((outcome) => `${outcome.type} ${outcome.path}: ${outcome.message}`).join("\n"),
			items: failures.map((outcome) => ({
				text: `${outcome.type} ${outcome.path}: ${outcome.message}`,
				state: "failed" as const,
			})),
		});
	return {
		...head,
		...(outcomes.length > 1
			? {
					outcome: {
						text:
							applied === outcomes.length
								? `Applied ${plural(applied, "change")}`
								: `Applied ${applied} of ${plural(outcomes.length, "change")}`,
						...(applied < outcomes.length ? { tone: "warning" as const } : {}),
					},
				}
			: {}),
		blocks,
	};
}
