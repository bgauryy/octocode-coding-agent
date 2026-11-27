import {
	type DraftAppender,
	leafContextEntries,
	leafProjection,
	leafProjectionView,
	previewProjection,
} from "./projection-memo.ts";
import * as sessionState from "./state.ts";
import { getDefaultSessionDirPath } from "./storage.ts";
import { buildSessionTree } from "./tree.ts";
import type {
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionNameSource,
	ReadonlySessionProjection,
	SessionProjection,
	SessionTreeNode,
} from "./types.ts";

/** The read-only accessors of a session manager over its shared state. */
export abstract class SessionReader {
	/** Entry, label and leaf state shared with the `session-manager/` modules. */
	protected readonly state: sessionState.SessionState;

	protected constructor(state: sessionState.SessionState) {
		this.state = state;
	}

	isPersisted(): boolean {
		return this.state.persist;
	}

	getCwd(): string {
		return this.state.cwd;
	}

	getSessionDir(): string {
		return this.state.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.state.sessionDir === getDefaultSessionDirPath(this.state.cwd);
	}

	getSessionId(): string {
		return this.state.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.state.sessionFile;
	}

	getSessionName(): string | undefined {
		return sessionState.getLatestSessionName(this.state);
	}

	getSessionNameSource(): SessionNameSource | undefined {
		return sessionState.getLatestSessionNameSource(this.state);
	}

	getLeafId(): string | null {
		return this.state.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.state.leafId ? this.state.byId.get(this.state.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.state.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		return sessionState.getChildEntries(this.state, parentId);
	}

	getLabel(id: string): string | undefined {
		return this.state.labelsById.get(id);
	}

	getBranch(fromId?: string): SessionEntry[] {
		return sessionState.getBranchEntries(this.state, fromId);
	}

	buildContextEntries(): SessionEntry[] {
		return leafContextEntries(this.state);
	}

	/** Kept between reads and extended by appends (`projection-memo.ts`); each call gets arrays of its own. */
	buildSessionProjection(): SessionProjection {
		return leafProjection(this.state);
	}

	/**
	 * `buildSessionProjection` without copying it, for readers that finish before the session changes: the next append may
	 * extend or replace what it holds, so copy the arrays a caller keeps or hands on.
	 */
	readSessionProjection(): ReadonlySessionProjection {
		return leafProjectionView(this.state);
	}

	/**
	 * The projection with what `apply` appends after the leaf, which the session does not keep: a turn boundary's preview
	 * of its drafts. Undefined when it cannot be built that way; see `previewProjection`.
	 */
	previewProjection(apply: (appender: DraftAppender) => void): ReadonlySessionProjection | undefined {
		return previewProjection(this.state, apply);
	}

	buildSessionContext(): SessionContext {
		const { messages, thinkingLevel, model } = this.buildSessionProjection();
		return { messages, thinkingLevel, model };
	}

	getHeader(): SessionHeader | null {
		return this.state.fileEntries.find((e) => e.type === "session") ?? null;
	}

	getEntryCount(): number {
		return this.state.byId.size;
	}

	getEntries(): SessionEntry[] {
		return sessionState.getSessionEntries(this.state);
	}

	getTree(): SessionTreeNode[] {
		return buildSessionTree(this.getEntries(), this.state.labelsById, this.state.labelTimestampsById);
	}
}
