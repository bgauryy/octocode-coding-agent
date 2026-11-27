import { formatAge } from "../components/session-selector/utils.ts";
import type { InteractiveModeHost } from "./host.ts";

type ResumeNoticeHost = Pick<InteractiveModeHost, "renderInitialMessages" | "sessionManager" | "showStatus">;

/** `Resumed <name or id> · <N> messages · last active <ago>`, from what the loaded session already holds. */
export function formatResumeNotice(
	host: Pick<InteractiveModeHost, "sessionManager">,
	now: number = Date.now(),
): string {
	const manager = host.sessionManager;
	const entries = manager.getEntries();
	const messages = entries.filter((entry) => entry.type === "message").length;
	const parts = [`Resumed ${manager.getSessionName() ?? manager.getSessionId().slice(0, 8)}`];
	parts.push(messages === 1 ? "1 message" : `${messages} messages`);
	const lastActive = entries.length > 0 ? new Date(entries[entries.length - 1].timestamp) : undefined;
	if (lastActive && !Number.isNaN(lastActive.getTime())) parts.push(`last active ${formatAge(lastActive, now)}`);
	return parts.join(" · ");
}

/** Redraws the loaded session; when it already has messages (continue or resume at launch), confirms which one. */
export function renderInitialSessionState(host: ResumeNoticeHost): void {
	host.renderInitialMessages();
	if (host.sessionManager.getEntries().some((entry) => entry.type === "message")) {
		host.showStatus(formatResumeNotice(host));
	}
}
