import {
	type ApplicationCursor,
	type ApplicationActivity,
	type ApplicationReceipt,
	type ApplicationSnapshot,
	parseApplicationFrame,
} from "@octocodeai/octocode-contacts";

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
				frame.event.text === undefined ||
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
				next = {
					...next,
					messages: (found
						? next.messages.map((message) => (message.id === event.message.id ? event.message : message))
						: [...next.messages, event.message]
					).slice(-200),
				};
				break;
			}
			case "message.delta":
				if (!next.messages.some((message) => message.id === event.messageId)) return this.resync();
				next = {
					...next,
					messages: next.messages.map((message) =>
						message.id === event.messageId
							? {
									...message,
									text: event.text ?? message.text + event.delta,
									...(event.content === undefined ? {} : { content: event.content }),
									...(event.full === undefined ? {} : { full: event.full }),
								}
							: message,
					),
				};
				break;
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
				const tool = {
					...previous,
					...data,
					toolCallId: event.toolCallId,
					order,
					toolName: event.toolName,
					...(hint ? { hint } : {}),
					text: event.text ?? previous?.text ?? "",
					status:
						event.type === "tool.completed"
							? event.failed
								? ("failed" as const)
								: ("completed" as const)
							: ("running" as const),
				};
				next = {
					...next,
					tools: [...tools.filter((previous) => previous.toolCallId !== tool.toolCallId), tool].slice(-50),
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
			case "session.status":
				next = { ...next, status: event.status };
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
