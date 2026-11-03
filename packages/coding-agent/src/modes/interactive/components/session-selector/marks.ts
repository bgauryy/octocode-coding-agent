import type { SessionInfo } from "../../../../core/session-manager.ts";
import type { SessionExtras } from "./types.ts";

/** Why a session cannot be deleted from the picker, or undefined when it can. Removal itself re-checks liveness. */
function deleteRefusal(session: SessionInfo, extras: SessionExtras | undefined, current: boolean): string | undefined {
	if (current) return "Cannot delete the currently active session";
	if (!session.path) return "This session has no file yet";
	if (extras?.live) return "This session is open in another Octocode process; close it there first";
	return undefined;
}

/** What the delete flow asks of the list that owns it. */
export interface DeleteFlowHost {
	extras(session: SessionInfo): SessionExtras | undefined;
	isCurrent(session: SessionInfo): boolean;
	/** The session under the cursor. */
	selected(): SessionInfo | undefined;
	moveDown(): void;
	error(message: string): void;
	/** The paths the user is asked to confirm deleting; null when no question is open. */
	confirmationChanged(paths: string[] | null): void;
	marksChanged(count: number): void;
}

/**
 * The picker's delete flow: rows marked with Ctrl+X (by transcript path, kept while the session stays listed) and the
 * one confirmation before the marked rows, or the selected row when none is marked, are deleted.
 */
export class DeleteFlow {
	private readonly marked = new Set<string>();
	private asking: string[] | null = null;
	private readonly host: DeleteFlowHost;

	constructor(host: DeleteFlowHost) {
		this.host = host;
	}

	get markedCount(): number {
		return this.marked.size;
	}

	isMarked(path: string): boolean {
		return this.marked.has(path);
	}

	/** Whether the confirmation question is open (it takes every key until answered). */
	get confirming(): boolean {
		return this.asking !== null;
	}

	isConfirming(path: string): boolean {
		return this.asking?.includes(path) ?? false;
	}

	/** Drops marks of sessions no longer listed. */
	keepOnly(listed: ReadonlySet<string>): void {
		for (const path of this.marked) if (!listed.has(path)) this.marked.delete(path);
	}

	clearMarks(): void {
		if (this.marked.size === 0) return;
		this.marked.clear();
		this.host.marksChanged(0);
	}

	private allowed(session: SessionInfo): boolean {
		const refusal = deleteRefusal(session, this.host.extras(session), this.host.isCurrent(session));
		if (refusal) this.host.error(refusal);
		return refusal === undefined;
	}

	/** Marks or unmarks the selected row and moves down, so a run of rows is marked by repeating the key. */
	toggleMark(): void {
		const session = this.host.selected();
		if (!session) return;
		if (!this.marked.has(session.path)) {
			if (!this.allowed(session)) return;
			this.marked.add(session.path);
		} else this.marked.delete(session.path);
		this.host.moveDown();
		this.host.marksChanged(this.marked.size);
	}

	/** Opens the question for the marked rows, or for the selected one when none is marked. */
	ask(): void {
		const session = this.host.selected();
		if (this.marked.size > 0) this.asking = [...this.marked];
		else if (session && this.allowed(session)) this.asking = [session.path];
		else return;
		this.host.confirmationChanged(this.asking);
	}

	/** Closes the question; returns the paths to delete when `confirmed`. A confirmed delete also clears the marks. */
	answer(confirmed: boolean): string[] {
		const paths = confirmed ? (this.asking ?? []) : [];
		this.asking = null;
		this.host.confirmationChanged(null);
		if (confirmed) this.clearMarks();
		return paths;
	}
}
