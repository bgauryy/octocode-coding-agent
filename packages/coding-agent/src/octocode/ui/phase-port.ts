import type { ApplicationEvent, ApplicationPhase } from "@octocodeai/octocode-contracts";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { getApplicationPortForSession, onApplicationPortOpened } from "../../core/application/index.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { isTerminalPhase, type SessionPhase, type SessionPhaseStore } from "../shared/session-phase.ts";
import { clipText } from "../shared/util.ts";

const clip = (value: string, max: number) => clipText(redactSecrets(value), max);
const refs = (items: readonly string[]) => items.slice(0, 50).map((item) => clip(item, 64));

/** The phase as the application protocol carries it: every string redacted and bounded. */
export function applicationPhaseOf(phase: SessionPhase): ApplicationPhase {
	switch (phase.state) {
		case "blocked":
			return { state: "blocked", title: clip(phase.title, 200) };
		case "working":
			return { state: "working", ...(phase.activity ? { activity: clip(phase.activity, 200) } : {}) };
		case "waiting":
			return {
				state: "waiting",
				agents: phase.agents,
				queued: phase.queued,
				bash: phase.bash,
				external: phase.external,
				...(phase.names ? { names: { agents: refs(phase.names.agents), bash: refs(phase.names.bash) } } : {}),
			};
		case "resuming":
			return { state: "resuming", ...(phase.label ? { label: clip(phase.label, 200) } : {}) };
		case "scheduled":
			return {
				state: "scheduled",
				timers: phase.timers,
				id: clip(phase.id, 64),
				...(phase.dueAt === undefined ? {} : { dueAt: phase.dueAt }),
				...(phase.label ? { label: clip(phase.label, 200) } : {}),
			};
		case "stopped":
			return { state: "stopped", open: refs(phase.open) };
		case "failed":
			return {
				state: "failed",
				error: clip(phase.error, 300),
				...(phase.open?.length ? { open: refs(phase.open) } : {}),
			};
		case "done":
		case "idle":
			return { state: phase.state };
	}
}

/**
 * Publishes the session's phase on its application port (`session.phase`) whenever it changes and when a session starts,
 * so the terminal host and the browser read the same answer to "is this session done?". The job's start rides along
 * while the phase is not final.
 */
export function registerPhasePort(api: FeatureSetup, phase: SessionPhaseStore): void {
	let sessionId: string | undefined;
	const event = (): ApplicationEvent => {
		const current = phase.phase();
		const startedAt = isTerminalPhase(current) ? undefined : phase.jobStartedAt();
		return {
			type: "session.phase",
			phase: applicationPhaseOf(current),
			...(startedAt === undefined ? {} : { jobStartedAt: startedAt }),
		};
	};
	const publish = () => {
		if (sessionId === undefined) return;
		getApplicationPortForSession(sessionId)?.publishDomain(event());
	};
	let stopWatching: (() => void) | undefined;
	api.bus.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		// A port opened after the last phase change (a host attaching while the session waits) starts from the current phase.
		stopWatching?.();
		stopWatching = onApplicationPortOpened((port) => {
			if (port.sessionId === sessionId) port.publishDomain(event());
		});
		publish();
	});
	api.bus.on("session_shutdown", async () => {
		stopWatching?.();
		stopWatching = undefined;
	});
	phase.subscribe(publish);
}
