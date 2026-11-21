import {
	appendApplicationMessage,
	type ApplicationCursor,
	type ApplicationActivity,
	type ApplicationMessage,
	type ApplicationTool,
	type ApplicationReceipt,
	type ApplicationSnapshot,
	parseApplicationFrame,
} from "@octocodeai/octocode-contracts";

type FrameResult = "applied" | "ignored" | "resync" | "invalid";

/** A view-local projection. Losing a delta invalidates the cursor until a fresh snapshot arrives. */
export class ApplicationStream {
	cursor: ApplicationCursor | undefined;
	snapshot: ApplicationSnapshot | undefined;
	at = 0;

	accept(value: unknown): FrameResult {
		const frame = parseApplicationFrame(value);
		if (!frame) return "invalid";
		if (frame.type === "snapshot") {
			if (frame.snapshot.sessionId !== frame.cursor.sessionId) return "invalid";
			this.snapshot = {
				...frame.snapshot,
				messages: [...frame.snapshot.messages],
				receipts: [...frame.snapshot.receipts],
				...(frame.snapshot.activities
					? retainActivities(frame.snapshot.activities, frame.snapshot.hasMoreActivities)
					: {}),
				...(frame.snapshot.errors ? { errors: frame.snapshot.errors.slice(-10) } : {}),
			};
			this.cursor = frame.cursor;
			this.at = frame.at;
			return "applied";
		}
		if (frame.type === "resync") return this.resync();
		if (this.snapshot && this.snapshot.sessionId !== frame.cursor.sessionId) return "ignored";
		if (!this.cursor || !this.snapshot || frame.cursor.epoch !== this.cursor.epoch) return this.resync();
		if (frame.type === "resumed") return frame.cursor.sequence === this.cursor.sequence ? "ignored" : this.resync();
		if (frame.cursor.sequence <= this.cursor.sequence) return "ignored";
		if (frame.cursor.sequence !== this.cursor.sequence + 1) {
			if (
				frame.type !== "event" ||
				frame.event.type !== "message.delta" ||
				(frame.event.text === undefined && frame.event.block === undefined) ||
				frame.fromSequence !== this.cursor.sequence + 1 ||
				frame.fromSequence >= frame.cursor.sequence
			)
				return this.resync();
		}
		const event = frame.event;
		let next = this.snapshot;
		switch (event.type) {
			case "session.model":
				next = { ...next, model: event.model };
				break;
			case "message.started":
			case "message.completed": {
				const found = next.messages.some((message) => message.id === event.message.id);
				const messages = found
					? next.messages.map((message) => (message.id === event.message.id ? event.message : message))
					: [...next.messages, event.message];
				next = { ...next, ...retainTranscript(messages, next.tools) };
				break;
			}
			case "message.delta": {
				const index = next.messages.findIndex((message) => message.id === event.messageId);
				if (index === -1) return this.resync();
				const message = next.messages[index];
				// A replacement owns all display fields; absent optional fields clear a previous asset or
				// rich body. A plain text append has no replacement fields and keeps the current shape.
				const replacement = event.text !== undefined || event.content !== undefined || event.full !== undefined;
				// An append continues the block exactly as this view holds it; any other state needs a fresh snapshot.
				const updated = event.block
					? appendApplicationMessage(message, event.block, event.delta)
					: {
							...message,
							text: event.text ?? message.text + event.delta,
							...(replacement ? { content: event.content, full: event.full } : {}),
						};
				if (!updated) return this.resync();
				const messages = [...next.messages];
				messages[index] = updated;
				next = { ...next, messages };
				break;
			}
			case "run.started":
				next = { ...next, runId: event.runId, streaming: true };
				break;
			case "run.settled":
				next = { ...next, runId: undefined, streaming: false };
				break;
			case "queue.changed":
				next = { ...next, steering: event.steering, followUp: event.followUp };
				break;
			case "command.receipt":
				this.acceptReceipt(event.receipt);
				next = this.snapshot!;
				break;
			case "tool.started":
			case "tool.progress":
			case "tool.completed": {
				const tools = next.tools ?? [];
				const previous = tools.find((tool) => tool.toolCallId === event.toolCallId);
				const hint = event.hint ?? previous?.hint;
				// Older hosts omit order from tool events. Keep a call's previous position or infer one after
				// the latest retained item; current hosts send the exact order even if older items were evicted.
				const order =
					event.order ??
					previous?.order ??
					Math.max(
						next.messages.reduce((last, message) => Math.max(last, message.order ?? -1), -1),
						tools.reduce((last, tool) => Math.max(last, tool.order ?? -1), -1),
					) + 1;
				const { type: _type, failed: _failed, ...data } = event;
				// As on the host: an event with result data replaces the previous result and its asset and progress.
				const kept = event.content === undefined ? previous : withoutResult(previous);
				const tool = {
					...kept,
					...data,
					toolCallId: event.toolCallId,
					order,
					toolName: event.toolName,
					...(hint ? { hint } : {}),
					text: event.text ?? previous?.text ?? "",
					notRun: event.notRun,
					status:
						event.type === "tool.completed"
							? event.failed
								? ("failed" as const)
								: ("completed" as const)
							: ("running" as const),
				};
				next = {
					...next,
					...retainTranscript(next.messages, [
						...tools.filter((previous) => previous.toolCallId !== tool.toolCallId),
						tool,
					]),
				};
				break;
			}
			case "application.error":
				next = { ...next, errors: [...(next.errors ?? []).filter((error) => error.id !== event.id), event].slice(-10) };
				break;
			case "session.activity": {
				const activities = [...(next.activities ?? []).filter((item) => item.id !== event.activity.id), event.activity];
				next = { ...next, ...retainActivities(activities, next.hasMoreActivities) };
				break;
			}
			case "session.reset":
				next = {
					...next,
					messages: event.messages,
					tools: event.tools,
					errors: (event.errors ?? []).slice(-10),
					...retainActivities(event.activities ?? [], event.hasMoreActivities),
				};
				break;
			case "session.status": {
				// The detail and the deadline belong to this status: an event without them clears the earlier ones.
				const { statusDetail: _detail, statusUntil: _until, ...rest } = next;
				next = {
					...rest,
					status: event.status,
					...(event.detail ? { statusDetail: event.detail } : {}),
					...(event.until === undefined ? {} : { statusUntil: event.until }),
				};
				break;
			}
			case "session.awaiting":
				next = { ...next, awaiting: event.awaiting };
				break;
			case "session.phase":
				next = { ...next, phase: event.phase, jobStartedAt: event.jobStartedAt };
				break;
		}
		this.snapshot = next;
		this.cursor = frame.cursor;
		this.at = frame.at;
		return "applied";
	}

	acceptReceipt(receipt: ApplicationReceipt): void {
		if (!this.snapshot) return;
		const previous = this.snapshot.receipts.find((item) => item.id === receipt.id);
		if (previous && previous.status !== "accepted" && receipt.status === "accepted") return;
		this.snapshot = {
			...this.snapshot,
			receipts: [...this.snapshot.receipts.filter((item) => item.id !== receipt.id), receipt].slice(-100),
		};
	}

	private resync(): "resync" {
		this.cursor = undefined;
		return "resync";
	}
}

const LIVE_MESSAGES = 200;
const LIVE_TOOLS = 200;

/** A tool's state without its result fields, which the next result replaces. */
function withoutResult(tool: ApplicationTool | undefined): Partial<ApplicationTool> | undefined {
	if (!tool) return tool;
	const {
		full: _full,
		details: _details,
		structuredContent: _structured,
		usage: _usage,
		progress: _progress,
		...kept
	} = tool;
	return kept;
}

/**
 * The live transcript: the newest messages, the tools that belong to them, and every tool at or after the first of
 * them. Loaded history (`history-window.ts`) takes the tools before that message as messages leave, so a tool leaves
 * the live window only when history can show it. When more tools than the cap follow, older messages leave first;
 * past the last message, the oldest tools do. A tool without an order (only an older host sends one) has no place a
 * history page could return it at, so it stays live and does not count toward the cap.
 */
function retainTranscript(source: readonly ApplicationMessage[], tools: readonly ApplicationTool[] | undefined) {
	let messages = source.slice(-LIVE_MESSAGES);
	if (!tools) return { messages };
	const from = (cut: number | undefined) => {
		const ids = new Set(messages.map((message) => message.id));
		const calls = new Set(messages.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
		return tools.filter(
			(tool) =>
				cut === undefined ||
				tool.order === undefined ||
				tool.order >= cut ||
				(tool.messageId !== undefined && ids.has(tool.messageId)) ||
				calls.has(tool.toolCallId),
		);
	};
	// Tools older than the first message leave only with the messages before it.
	let live = messages.length < source.length ? from(messages[0]?.order) : [...tools];
	const ordered = (list: readonly ApplicationTool[]) => list.filter((tool) => tool.order !== undefined).length;
	if (ordered(live) > LIVE_TOOLS) {
		const orders = live.flatMap((tool) => (tool.order === undefined ? [] : [tool.order])).sort((a, b) => a - b);
		const floor = orders[orders.length - LIVE_TOOLS];
		const after = messages.findIndex((message) => message.order === undefined || message.order > floor);
		if (floor !== undefined) messages = messages.slice(after === -1 ? -1 : after);
		live = from(messages[0]?.order);
		let excess = ordered(live) - LIVE_TOOLS;
		live = live.filter((tool) => tool.order === undefined || excess-- <= 0);
	}
	return { messages, tools: live };
}

/** Match the host's retained window so a reconnect does not change which notices need paging. */
function retainActivities(source: ApplicationActivity[], hasMoreActivities?: boolean) {
	const activities = source.slice(-50);
	while (activities.length > 1 && JSON.stringify(activities).length > 32768) activities.shift();
	return {
		activities,
		activityBefore: activities[0]?.id,
		hasMoreActivities: activities.length < source.length ? true : hasMoreActivities,
	};
}
