import type { Permission } from "../../permission/ask.ts";
import type { HostLookup } from "../../../../../common/src/web-guard.ts";
import type { BrowserSession } from "../cdp/browser-session.ts";
import { PagePolicy } from "../network.ts";
import type { NetworkEvent } from "../policy.ts";
import type { BlockedConnection } from "../proxy.ts";
import { openBrowser } from "../session.ts";
import type { Approval } from "../tabs.ts";
import { checkBrowserUrl, type Confirmer } from "./checks.ts";

/** The refusals and reports kept apart in the audit (`BrowserTool.#audited`), most distinct ones, and how soon a repeat count is written. */
export const AUDIT_KEYS_MAX = 100;
const AUDIT_FLUSH_MS = 10_000;
const OVERFLOW_KEY = "more distinct refusals";

interface Audited {
	repeats: number;
	/** The repeat count the audit already holds. */
	written: number;
	write: (repeats: number) => void;
}

/** Before any tool call supplies a context: nothing to ask, so what needs confirmation is refused. */
const NO_UI = { hasUI: false } as Confirmer;

export class BrowserTool {
	#session: BrowserSession | undefined;
	/** The latest tool call's context: where the navigation guard asks for confirmation. */
	#confirmer: Confirmer = NO_UI;
	/** The latest tool call's id: what the asks the call raises are tied to. */
	#callId: string | undefined;
	/** What the session's pages may request: every request, not only URLs the agent passes. Private hosts only when the agent opened them. */
	readonly #policy: PagePolicy;
	/**
	 * Refusals and reports already in the audit, by what tells one from another (kind, host and port, resource type,
	 * reason). A page that repeats one writes it once; the repeats are counted and audited as a summary shortly after
	 * (`AUDIT_FLUSH_MS`) and again when the browser session ends, so a crash loses at most the last interval's counts.
	 * At `AUDIT_KEYS_MAX` distinct entries the others are counted under one entry that says how many more distinct
	 * refusals there were (`OVERFLOW_KEY`), so a page cannot flood the audit and nothing is dropped silently.
	 */
	readonly #audited = new Map<string, Audited>();
	#flushTimer: NodeJS.Timeout | undefined;
	/** Resolves host names for the check on the pages the agent opens, and for what pages request; the `web` tool's resolver by default. */
	readonly #lookup: HostLookup | undefined;
	/** What the last session lost before it ended (a tab closed for DNS rebinding), told with the next session's first result. */
	#notice: string | undefined;

	readonly #flushMs: number;

	/** `permission` asks about the pages the agent opens, private hosts and uploads; its session grants remember the hosts the user allowed. `flushMs`: how soon a repeat count is audited (a seam for tests). */
	readonly permission: Permission;
	constructor(permission: Permission, options: { lookup?: HostLookup; flushMs?: number } = {}) {
		this.permission = permission;

		this.#lookup = options.lookup;
		this.#flushMs = options.flushMs ?? AUDIT_FLUSH_MS;
		this.#policy = new PagePolicy({
			report: (event) => this.#audit(event),
			...(options.lookup ? { lookup: options.lookup } : {}),
		});
	}

	/**
	 * Whether the agent may open `url` (navigate, a new tab, switching to a tab): the page's own ask, one prompt for a
	 * private host. The host is classified once, there; a private target the permission allowed is the one the page may
	 * load from, and the launched Chrome's proxy lets it through. The approval it returns is recorded for the tab that loads
	 * the page (`approve(tab)`): it lasts for the whole browser session when the user granted `net.private` for the
	 * session, otherwise (Allow once, or a mode that allows it) while that tab stays on the host. A public one is never
	 * approved: if its name answers privately later, the page request, the proxy and the rebinding check refuse it.
	 */
	async open(url: string): Promise<Approval> {
		const { privateGrant } = await checkBrowserUrl(
			url,
			this.#confirmer,
			this.permission,
			this.#callId ?? "",
			this.#lookup,
		);
		if (!privateGrant) return () => undefined;
		const target = new URL(url);
		return (tab) => this.#policy.approve(target, privateGrant === "session" ? "session" : { tab });
	}

	/** One audit entry per distinct refusal or report: a page with many identical blocked requests is one entry and a count, not many entries. */
	#audit(event: NetworkEvent): void {
		if (event.kind === "rebinding") {
			// Reported before the close is attempted; the console log says whether it succeeded (`page-network.ts`, closeRebound).
			this.#notice = `Closing the tab: ${event.url} answered from the private address ${event.address} (DNS rebinding).`;
			this.permission.refused(
				[`${event.url} -> ${event.address}`],
				"closing the tab: a public name answered from a private address (DNS rebinding)",
				"browser",
			);
		} else if (event.kind === "blocked") {
			this.#auditOnce(`blocked ${hostOf(event.url)} ${event.resourceType} ${event.reason}`, (repeats) =>
				this.permission.refused(
					[event.url],
					`${repeatNote(repeats)}blocked a page request (${event.resourceType}): ${event.reason}`,
					"browser",
				),
			);
		} else {
			this.#auditOnce(`websocket ${hostOf(event.url)} ${event.reason}`, (repeats) =>
				this.permission.noted(
					[event.url],
					`${repeatNote(repeats)}a page WebSocket was not blocked, reported only: ${event.reason}`,
					{ allowed: true, via: "reported", action: "invariant", tool: "browser" },
				),
			);
		}
	}

	/** A connection the launched Chrome's filtering proxy refused (a page chose a private or unvetted host). */
	#auditProxy(blocked: BlockedConnection): void {
		this.#auditOnce(`proxy ${blocked.host} ${blocked.reason}`, (repeats) =>
			this.permission.refused(
				[blocked.host],
				`${repeatNote(repeats)}the filtering proxy refused a page connection to ${blocked.reason === "private" ? "a local or private address" : "a host it could not vet"}`,
				"browser",
			),
		);
	}

	/** Writes `write(0)` the first time `key` is seen; later ones are only counted, for `#flushRepeats`. Past `AUDIT_KEYS_MAX` distinct keys a new one is counted under `OVERFLOW_KEY`. */
	#auditOnce(key: string, write: (repeats: number) => void): void {
		const overflow = !this.#audited.has(key) && this.#audited.size >= AUDIT_KEYS_MAX;
		const name = overflow ? OVERFLOW_KEY : key;
		const known = this.#audited.get(name);
		if (known) {
			known.repeats += 1;
			this.#scheduleFlush();
			return;
		}
		const writer = overflow
			? (repeats: number) =>
					this.permission.refused(
						[`more than ${AUDIT_KEYS_MAX} distinct blocked targets`],
						`${repeats + 1} more distinct refusals or reports after the first ${AUDIT_KEYS_MAX}, counted here and not listed one by one`,
						"browser",
					)
			: write;
		this.#audited.set(name, { repeats: 0, written: 0, write: writer });
		writer(0);
	}

	/** Audits the counts that grew soon, so a crash or a kill loses little: repeats are cumulative, a later summary replaces an earlier one. */
	#scheduleFlush(): void {
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flushRepeats();
		}, this.#flushMs);
		this.#flushTimer.unref();
	}

	/** Audits the count of each entry that repeated since it was last written. */
	#flushRepeats(): void {
		for (const entry of this.#audited.values()) {
			if (entry.repeats <= entry.written) continue;
			entry.written = entry.repeats;
			entry.write(entry.repeats);
		}
	}

	/** Audits what is left and starts afresh: the browser session the entries belong to ended. */
	#endAudit(): void {
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#flushRepeats();
		this.#audited.clear();
	}

	/** Remembers the calling tool's context for confirmations the session's pages trigger while it runs. */
	useContext(ctx: Confirmer | undefined, toolCallId?: string): void {
		this.#confirmer = ctx ?? NO_UI;
		this.#callId = toolCallId;
	}

	/** Whether a browser is open now, without opening one. */
	get isOpen(): boolean {
		return this.#session?.page.open === true;
	}

	async session(signal?: AbortSignal): Promise<BrowserSession> {
		if (this.#session?.page.open) return this.#session;
		// The page connection dropped: release what the old session owns before opening a new one.
		await this.close();
		return this.#start({ signal });
	}

	/** Drive a browser that is already open on a DevTools port, in its current page, instead of opening our own. */
	async attach(port: number | undefined, signal?: AbortSignal): Promise<BrowserSession> {
		if (!port) throw new Error("attach needs port (the DevTools port of an open browser).");
		await this.close();
		return this.#start({ port, reuseTab: true, signal });
	}

	async #start(options: {
		port?: number;
		reuseTab?: boolean;
		signal: AbortSignal | undefined;
	}): Promise<BrowserSession> {
		const session = await openBrowser(process.env, {
			...options,
			policy: this.#policy,
			onBlocked: (blocked) => this.#auditProxy(blocked),
		});
		if (this.#notice) session.warning = this.#notice;
		this.#notice = undefined;
		this.#session = session;
		return session;
	}

	/**
	 * Ends the session. With `keepVisible` (session shutdown) a visible Chrome on the persistent profile stays open with
	 * its tab, so the user can finish a login there and the next session reuses it.
	 */
	async close(options: { keepVisible?: boolean } = {}): Promise<void> {
		const session = this.#session;
		this.#session = undefined;
		// What the browser session allowed and refused ends with it: a new Chrome starts with no approved host.
		this.#policy.revoke();
		this.#endAudit();
		if (!session) return;
		const keep = options.keepVisible === true && session.profile !== undefined;
		// A persistent-profile Chrome left open by an earlier run is quit by an explicit close, like one we launched.
		if (!keep && session.profile !== undefined && !session.chrome)
			await session.connection.send("Browser.close").catch(() => undefined);
		else if (!keep) await session.closeTab?.().catch(() => undefined);
		session.connection.close();
		session.consoleLog?.close();
		// Detached: Chrome runs in its own process group, so it outlives this process once nothing waits on it.
		if (keep) session.chrome?.process?.unref();
		else await session.chrome?.kill();
	}
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

/** Leads the audit reason of a summary (a long reason may be cut for display, so the count goes first). */
const repeatNote = (repeats: number): string => (repeats > 0 ? `(${repeats + 1} times this browser session) ` : "");
