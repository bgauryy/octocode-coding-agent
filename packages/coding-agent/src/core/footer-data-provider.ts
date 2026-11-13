import { type FSWatcher, existsSync, readFileSync, type Stats, unwatchFile, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";
import {
	findGitPaths,
	type GitPaths,
	readGitStateSignature,
	resolveBranchWithGitAsync,
	resolveBranchWithGitSync,
	shouldPollGitHead,
} from "./footer-data-provider/git.ts";
import { sameStatus, type StatusEntry, type StatusTone, statusEntry } from "./footer-data-provider/status.ts";

export { findGitPaths } from "./footer-data-provider/git.ts";
export type { StatusEntry, StatusTone } from "./footer-data-provider/status.ts";

/** One immutable snapshot of the footer data, a new object after each change; plain data any renderer can draw. */
export interface FooterData {
	readonly branch: string | null;
	readonly statuses: ReadonlyMap<string, StatusEntry>;
	readonly providerCount: number;
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Context usage on ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), model info on ctx.model.
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, StatusEntry>();
	/** The statuses' texts, as extensions read them; derived once per change. */
	private statusTexts: ReadonlyMap<string, string> | undefined;
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private headWatchFilePath: string | null = null;
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatchFilePath: string | null = null;
	private reftableWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private gitWatcherGeneration = 0;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	/** Git state the cached branch was last resolved from; null forces the next refresh to resolve again. */
	private lastRefreshSignature: string | null = null;
	private disposed = false;
	private snapshot: FooterData | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** The current snapshot (the `StateSource` read side). */
	getState(): FooterData {
		this.snapshot ??= {
			branch: this.getGitBranch(),
			statuses: this.extensionStatuses,
			providerCount: this.availableProviderCount,
		};
		return this.snapshot;
	}

	/** Called after each change of any footer data; unchanged writes notify nobody. Returns the unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		this.snapshot = undefined;
		this.statusTexts = undefined;
		for (const listener of this.listeners) listener();
	}

	/** Extension status texts set via ctx.ui.setStatus(); `getState().statuses` adds each one's tone. */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		this.statusTexts ??= new Map([...this.extensionStatuses].map(([key, entry]) => [key, entry.text]));
		return this.statusTexts;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	setExtensionStatus(key: string, text: string | undefined, tone?: StatusTone): void {
		const entry = text === undefined ? undefined : statusEntry(text, tone);
		if (sameStatus(this.extensionStatuses.get(key), entry)) return;
		// Copy on write: a snapshot taken earlier keeps the statuses it had.
		const next = new Map(this.extensionStatuses);
		if (entry === undefined) next.delete(key);
		else next.set(key, entry);
		this.extensionStatuses = next;
		this.changed();
	}

	clearExtensionStatuses(): void {
		if (this.extensionStatuses.size === 0) return;
		this.extensionStatuses = new Map();
		this.changed();
	}

	/** Number of unique providers with available models (for footer display) */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	setAvailableProviderCount(count: number): void {
		if (this.availableProviderCount === count) return;
		this.availableProviderCount = count;
		this.changed();
	}

	setCwd(cwd: string): void {
		if (this.disposed || this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.lastRefreshSignature = null;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
		this.listeners.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
		this.changed();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		// One change reaches us through several watchers (HEAD dir, reftable dir, the WSL HEAD poll), and fs.watch can replay events from before the watcher started. Skip the git call when
		// the files that determine the branch are unchanged since the last successful resolution.
		const gitPaths = this.gitPaths;
		const signature = readGitStateSignature(gitPaths);
		if (signature !== null && signature === this.lastRefreshSignature) return;

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			// A repository switch can complete before the old git subprocess does.
			if (this.disposed || this.gitPaths !== gitPaths) return;
			this.lastRefreshSignature = nextBranch === null ? null : signature;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private clearGitWatchers(): void {
		// A closed watcher can still deliver callbacks; invalidate those before closing any watcher.
		this.gitWatcherGeneration++;
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		if (this.headWatchFilePath && this.headWatchFileListener) {
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			this.headWatchFilePath = null;
			this.headWatchFileListener = null;
		}
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		if (this.reftableWatchFilePath && this.reftableWatchFileListener) {
			unwatchFile(this.reftableWatchFilePath, this.reftableWatchFileListener);
			this.reftableWatchFilePath = null;
			this.reftableWatchFileListener = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
			// Re-arming does not replay branch changes made while no watcher was attached.
			this.scheduleRefresh();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (this.disposed || !this.gitPaths) return;
		const generation = this.gitWatcherGeneration;
		const current = () => !this.disposed && this.gitWatcherGeneration === generation;
		const onError = () => {
			if (current()) this.handleGitWatcherError();
		};

		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (current() && (!filename || filename === "HEAD")) {
					this.scheduleRefresh();
				}
			},
			onError,
		);
		if (pollGitHead) {
			// WSL polling must still work if the native watcher failed synchronously and scheduled a retry.
			const pollGeneration = this.gitWatcherGeneration;
			this.headWatchFilePath = this.gitPaths.headPath;
			this.headWatchFileListener = (next, previous) => {
				if (
					!this.disposed &&
					this.gitWatcherGeneration === pollGeneration &&
					(next.mtimeMs !== previous.mtimeMs || next.ctimeMs !== previous.ctimeMs || next.size !== previous.size)
				) {
					this.scheduleRefresh();
				}
			};
			watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
			// WSL may miss native directory events; reftable branch changes can leave HEAD unchanged.
			if (existsSync(reftableDir)) {
				this.reftableWatchFilePath = join(reftableDir, "tables.list");
				this.reftableWatchFileListener = this.headWatchFileListener;
				watchFile(this.reftableWatchFilePath, { interval: 1000 }, this.reftableWatchFileListener);
			}
		}
		if (!current()) return;
		if (!this.headWatcher && !pollGitHead) {
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					if (current()) this.scheduleRefresh();
				},
				onError,
			);
			// Native directory watches follow atomic replacements; WSL alone also polls tables.list.
		}
	}
}

/**
 * Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose. The host's
 * provider always has `getState`/`subscribe` (a state source of `FooterData`); they are optional for older test doubles.
 */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
> &
	Partial<Pick<FooterDataProvider, "getState" | "subscribe">>;
