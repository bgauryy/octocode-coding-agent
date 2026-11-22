import { Box, type Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { resultBlock, toolHeader } from "../render/tool.ts";
import type { RenderContext } from "../render/types.ts";
import { isInformativeReason } from "../shared/reason.ts";
import { clip } from "../shared/text.ts";
import { formatDuration } from "../shared/format.ts";
import type { TaskDetails } from "./report.ts";

/** A finished job: `Web(task-1: fetch …) · background`, `↳ why`, `⎿ finished after 3s`, then what the work returned. */
export function renderTaskMessage(
	text: string,
	expanded: boolean,
	theme: Theme,
	outputPad = 1,
	details?: unknown,
): Component {
	const facts = isRecord(details) ? (details as Partial<TaskDetails>) : {};
	const [head = "", ...rest] = text.split("\n");
	const ok = facts.ok === true;
	const stopped = facts.interrupted === true;
	const name = facts.tool ? facts.tool.replace(/^mcp__/, "") : "Job";
	const summary =
		facts.how !== undefined && facts.seconds !== undefined
			? `${facts.how} after ${formatDuration(facts.seconds * 1000)}`
			: head;
	const context: RenderContext = { isPartial: false, isError: !ok, expanded, state: stopped ? { stopped: true } : {} };
	const box = new Box(outputPad, 0);
	const lines = isInformativeReason(facts.why) ? [theme.fg("toolReason", `↳ ${clip(facts.why ?? "", 200)}`)] : [];
	box.addChild(
		toolHeader(theme, context, name, facts.id ? `${facts.id}: ${facts.title ?? ""}` : head, {
			lines,
			meta: "background",
		}),
	);
	box.addChild(
		resultBlock(theme, context, { summary, body: rest.slice(1).join("\n"), tail: false, error: !ok, stopped }),
	);
	return box;
}
