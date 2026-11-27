import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import type { WorkspaceEvent } from "@octocodeai/octocode-contracts/workspace";

/** The four things the page tells the user about while it is out of sight. */
type NoticeKind = "approval" | "question" | "finished" | "failed";

export interface Notice {
	/** Identifies the event: the same key is never raised twice. Also the notification's `tag`. */
	key: string;
	kind: NoticeKind;
	title: string;
	body: string;
	/** The view a click opens in this session. */
	hash: string;
}

export interface WorkspaceFeed {
	sessionId: string;
	events: readonly WorkspaceEvent[];
}

const FAILED_STATUSES = ["failed", "error", "blocked"];
const BODY_LIMIT = 160;

function brief(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > BODY_LIMIT ? `${line.slice(0, BODY_LIMIT - 1)}…` : line;
}

function detailStatus(event: WorkspaceEvent): string {
	const details = event.details;
	return details !== null && typeof details === "object" && "status" in details ? String(details.status) : "";
}

/** A workspace event that reports a failure the user should hear about; routine tool errors and replies are not one. */
function failedEvent(event: WorkspaceEvent): boolean {
	if (event.type.startsWith("tool.") || event.type === "message") return false;
	return event.outcome === "failed" || FAILED_STATUSES.includes(detailStatus(event));
}

/**
 * Turns the session's state into notices, each once. State it has already seen is remembered, so a re-render, a
 * reconnect or a repeated snapshot raises nothing new. It reads:
 * - `ApplicationSnapshot.awaiting` (`kind` approval or question, keyed by its `id`): a dialog waiting for the user;
 * - `ApplicationSnapshot.streaming`/`runId` and the last assistant message's `status`: a turn that ended, finished or failed;
 * - `WorkspaceSnapshot.events` with type `agent.result` (a subagent or task finished) or any non-tool event whose
 *   `outcome` is `failed`. Events present when a session is first seen are history and stay silent.
 */
export class NoticeTracker {
	private readonly seen = new Set<string>();
	private applicationSession: string | undefined;
	private run: string | undefined;
	private eventSession: string | undefined;

	observe(application: ApplicationSnapshot | undefined, workspace: WorkspaceFeed | undefined): Notice[] {
		return [...this.fromApplication(application), ...this.fromEvents(workspace)];
	}

	private once(notice: Notice): Notice[] {
		if (this.seen.has(notice.key)) return [];
		this.seen.add(notice.key);
		return [notice];
	}

	private fromApplication(application: ApplicationSnapshot | undefined): Notice[] {
		if (!application) return [];
		if (application.sessionId !== this.applicationSession) {
			this.applicationSession = application.sessionId;
			this.run = undefined;
		}
		const notices: Notice[] = [];
		const { awaiting } = application;
		if (awaiting) {
			const approval = awaiting.kind === "approval";
			notices.push(
				...this.once({
					key: `await:${application.sessionId}:${awaiting.id ?? `${awaiting.kind}:${awaiting.title ?? ""}`}`,
					kind: awaiting.kind,
					title: approval ? "Approval needed" : "Question for you",
					body: awaiting.title ?? (approval ? "An action is waiting for your approval." : "The agent is asking you."),
					hash: "#activity",
				}),
			);
		}
		const current = application.streaming ? application.runId : undefined;
		const ended = this.run;
		this.run = current;
		if (ended && current !== ended) notices.push(...this.turnEnded(application, ended));
		return notices;
	}

	private turnEnded(application: ApplicationSnapshot, runId: string): Notice[] {
		const last = application.messages.findLast((message) => message.role === "assistant");
		const key = `run:${application.sessionId}:${runId}`;
		if (last?.status === "aborted" || last?.status === "interrupted") return [];
		if (last?.status === "failed")
			return this.once({
				key,
				kind: "failed",
				title: "Run failed",
				body: brief(last.errorMessage ?? "The agent's turn ended with an error."),
				hash: "#activity",
			});
		return this.once({
			key,
			kind: "finished",
			title: "Run finished",
			body: brief(last?.text ?? "") || "The agent finished its turn.",
			hash: "#activity",
		});
	}

	private fromEvents(workspace: WorkspaceFeed | undefined): Notice[] {
		if (!workspace || !workspace.sessionId) return [];
		const first = workspace.sessionId !== this.eventSession;
		this.eventSession = workspace.sessionId;
		const notices: Notice[] = [];
		for (const event of workspace.events) {
			const key = `event:${workspace.sessionId}:${event.type}:${event.id}`;
			const known = this.seen.has(key);
			this.seen.add(key);
			if (first || known) continue;
			if (failedEvent(event))
				notices.push({
					key,
					kind: "failed",
					title: event.type === "agent.result" ? "Agent failed" : "Something failed",
					body: brief(event.text) || "See the activity view.",
					hash: event.type.startsWith("agent.") ? "#profiler?panel=overview" : "#activity",
				});
			else if (event.type === "agent.result")
				notices.push({
					key,
					kind: "finished",
					title: "Agent finished",
					body: brief(event.text) || "A subagent or task completed.",
					hash: "#profiler?panel=overview",
				});
		}
		return notices;
	}
}

/** The window needs no notice while the user is looking at it. */
export function shouldNotify(page: { visibilityState: string; hasFocus(): boolean }): boolean {
	return !(page.visibilityState === "visible" && page.hasFocus());
}
