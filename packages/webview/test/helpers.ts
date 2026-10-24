import type { SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";

/** A backlog item with empty content; tests override the fields they read. */
export function snapshotItem(ref: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem {
	return {
		ref,
		title: `Item ${ref}`,
		goal: "",
		body: "",
		paths: [],
		why: "",
		evidence: [],
		plan: "",
		state: "backlog",
		priority: "p2",
		tags: [],
		createdBy: "author",
		createdAt: 0,
		updatedAt: 0,
		version: 1,
		derived: [],
		notes: [],
		...overrides,
	};
}

/** A WebSocket stand-in for the live session; `receive` delivers one typed server frame. */
export class FakeSocket {
	static OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 1;
	onmessage?: (event: { data: string }) => void;
	onopen?: () => void;
	onclose?: (event: { code: number }) => void;
	onerror?: () => void;
	constructor() {
		FakeSocket.instances.push(this);
	}
	send() {}
	close(code = 1000) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
	receive(type: string, data: unknown) {
		this.onmessage?.({ data: JSON.stringify({ type, data }) });
	}
}
