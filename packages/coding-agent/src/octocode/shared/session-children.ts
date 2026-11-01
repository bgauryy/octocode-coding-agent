import path from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { agentCall } from "./agent-call.ts";
import { fencedParts } from "./fence.ts";
import { AGENT_RESULT_TYPE } from "./messages.ts";
import { entryMessage } from "./util.ts";
import { regularReportFile, reportArtifact, type ReportArtifact } from "./report-artifact.ts";
export { readChildReport } from "./report-artifact.ts";

/**
 * The subagents a session started, read from its entries: each `agent` task result (`RunDetails`) and each background
 * report (`ResultDetails`, `AGENT_RESULT_TYPE`) names the child, its status and its saved conversation (`details.session`).
 * The session's own record is the authority: a child it does not name is not its child.
 */

/** Where a child's saved conversation and report are, from the `session` its details recorded. */
export interface ChildFiles {
	/** Its transcript file, once the run ended (`session.file`). */
	transcript?: string;
	/** Its session folder (`session.dir`), recorded when the run starts: the transcript is written there. */
	folder?: string;
	/** Its whole report (`report.md` in its scratch folder), when the report was long enough to be saved. */
	report?: string;
}

/** The files a run's `session` details point at; the report only when it exists. */
export function childFiles(session: unknown): ChildFiles {
	if (!isRecord(session)) return {};
	const transcript = typeof session.file === "string" ? session.file : undefined;
	const folder = typeof session.dir === "string" ? session.dir : transcript ? path.dirname(transcript) : undefined;
	// The session folder is `<scratch>/session`; the report is saved beside it.
	const report = folder ? path.join(path.dirname(folder), "report.md") : undefined;
	return {
		...(transcript ? { transcript } : {}),
		...(typeof session.dir === "string" ? { folder: session.dir } : {}),
		...(report && regularReportFile(report) ? { report } : {}),
	};
}

/** One subagent this session started, as its latest record says. */
export interface SessionChild {
	id: string;
	profile: string;
	goal: string;
	/** `background` while its report has not arrived; else `done`, `failed` or `stopped`. */
	status: string;
	/** The outcome its report named (`done`, `partial`, `blocked`, `failed`). */
	outcome?: string;
	transcript?: string;
	/** Its session folder while its transcript file is not recorded (a background run whose report never arrived). */
	folder?: string;
	report?: string;
	reportArtifact?: ReportArtifact;
	/** It ran in a private worktree, removed when it ended. */
	isolated?: true;
	/** The browser mode the call chose. */
	headless?: boolean;
	/** The `provider/id` (with any `:thinking`) it ran on; absent when it ran on the parent's model. */
	model?: string;
	/** Its latest run exited before its first model turn (`details.startup`), so no conversation may be saved. */
	startupFailed?: true;
	/** With `startupFailed`: the task it was started with (a resume of a child that never saved a conversation keeps the earlier one). */
	task?: string;
	/** The child's own words in its latest report as this session received it (the fenced body; a long one is cut). */
	reportText?: string;
	/** When that report arrived (epoch ms), when the entry recorded it. */
	reportAt?: number;
}

/** The fenced body of a report entry's text, and when it arrived; undefined for a start receipt or an unfenced stop notice. */
function reportOf(entry: unknown, message: Record<string, unknown>): { text: string; at?: number } | undefined {
	const content = isRecord(entry) && entry.type === "custom_message" ? entry.content : message.content;
	const whole =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
				: "";
	const body = fencedParts(whole)?.body;
	if (body === undefined) return undefined;
	const stamp =
		typeof message.timestamp === "number"
			? message.timestamp
			: isRecord(entry)
				? Date.parse(String(entry.timestamp))
				: NaN;
	return { text: body, ...(Number.isFinite(stamp) ? { at: stamp } : {}) };
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Every subagent the entries name, in the order they started, each with its latest status and files. */
export function sessionChildren(entries: readonly unknown[]): SessionChild[] {
	const inputs = new Map<string, Record<string, unknown>>();
	const children = new Map<string, SessionChild>();
	const runs = new Map<string, { id?: string; startedAt?: number }>();
	const retired = new Set<string>();
	const tasks = new Map<string, string>();
	const rememberRun = (id: string, details: Record<string, unknown>) => {
		const run = {
			id: text(details.runId),
			startedAt: typeof details.startedAt === "number" ? details.startedAt : undefined,
		};
		const previous = runs.get(id)?.id;
		if (previous && previous !== run.id) retired.add(previous);
		runs.set(id, run);
	};
	const update = (child: SessionChild, details: Record<string, unknown>, report?: { text: string; at?: number }) => {
		const status = text(details.status);
		if (status && status !== "waiting" && status !== "running") child.status = status;
		if (report && status !== "background") {
			child.reportText = report.text;
			if (report.at === undefined) delete child.reportAt;
			else child.reportAt = report.at;
		}
		const outcome = text(details.outcome);
		if (outcome) child.outcome = outcome;
		const files = childFiles(details.session);
		if (files.transcript) {
			child.transcript = files.transcript;
			delete child.folder;
		} else if (files.folder && !child.transcript) child.folder = files.folder;
		const artifact = reportArtifact(details.reportArtifact);
		if (artifact) {
			child.reportArtifact = artifact;
			delete child.report;
			const folder = files.folder ?? (files.transcript ? path.dirname(files.transcript) : undefined);
			// The host's saved session establishes the scratch boundary; metadata cannot choose another child's file.
			if (artifact.path && folder && path.dirname(artifact.path) === path.dirname(folder)) child.report = artifact.path;
		} else if (report) {
			// A legacy transcript is current evidence. An unversioned report.md may belong to an older continuation.
			delete child.report;
			delete child.reportArtifact;
		} else if (files.report && !children.has(child.id)) child.report = files.report;
		const model = text(details.model);
		if (model) child.model = model;
		if (isRecord(details.startup) && details.startup.failed === true) child.startupFailed = true;
		else delete child.startupFailed;
	};
	for (const entry of entries) {
		const message = entryMessage(entry);
		if (!isRecord(message)) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content)
				if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && isRecord(part.arguments))
					inputs.set(part.id, part.name === "agent" ? agentCall(part.arguments).input : part.arguments);
			continue;
		}
		const details = isRecord(message.details) ? message.details : undefined;
		const id = text(details?.id);
		if (!details || !id) continue;
		if (message.role === "custom" && message.customType === AGENT_RESULT_TYPE) {
			const child = children.get(id);
			const runId = text(details.runId);
			const previous = runs.get(id);
			if (!runId && previous?.id) continue;
			if (runId && retired.has(runId)) continue;
			if (
				typeof details.startedAt === "number" &&
				previous?.startedAt !== undefined &&
				details.startedAt < previous.startedAt
			)
				continue;
			// A message can continue a lingering child without a new task result; its later report advances the history.
			if (child) {
				if (child.status !== "background" || (runId && runId !== previous?.id)) {
					delete child.report;
					delete child.reportArtifact;
					delete child.reportText;
					delete child.reportAt;
				}
				delete child.outcome;
				rememberRun(id, details);
				update(child, details, reportOf(entry, message));
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "agent") continue;
		if (details.agentType !== undefined && details.agentType !== "task") continue;
		const profile = text(details.profile);
		if (!profile) continue;
		const input = inputs.get(String(message.toolCallId)) ?? {};
		const child: SessionChild = children.get(id) ?? { id, profile, goal: text(details.goal) ?? "", status: "" };
		if (children.has(id)) {
			delete child.report;
			delete child.reportArtifact;
			delete child.reportText;
			delete child.reportAt;
		}
		rememberRun(id, details);
		delete child.outcome;
		child.profile = profile;
		child.goal = text(details.goal) ?? child.goal;
		if (input.isolate === true) child.isolated = true;
		else delete child.isolated;
		if (typeof input.headless === "boolean") child.headless = input.headless;
		const task = text(input.task);
		if (task && !(input.resume === id && tasks.has(id))) tasks.set(id, task);
		update(child, details, reportOf(entry, message));
		children.set(id, child);
	}
	for (const child of children.values()) {
		const task = child.startupFailed ? tasks.get(child.id) : undefined;
		if (task) child.task = task;
	}
	return [...children.values()];
}
