import {
	type ApplicationCursor,
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
		if (frame.cursor.sequence !== this.cursor.sequence + 1) return this.resync();
		const event = frame.event;
		let next = this.snapshot;
		switch (event.type) {
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
						message.id === event.messageId ? { ...message, text: event.text ?? message.text + event.delta } : message,
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
				const tool = {
					toolCallId: event.toolCallId,
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
