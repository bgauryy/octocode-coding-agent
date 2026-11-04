import type {
	AcpLaunchOptions,
	AcpServerHost,
	AcpTranscriptEntry,
	AcpUiRequest,
	AcpWorkerClient,
	AcpWorkerEvent,
	AcpWorkerLaunch,
} from "../../../acp/src/host.ts";
import { ENV_SESSION_DIR, getAgentDir, getCliInvocation, isBunBinary, VERSION } from "../config.ts";
import { compactionSummaryDisplay, createCustomMessage } from "../core/messages.ts";
import { flushRawStdout, takeOverStdout, writeRawStdoutAsync } from "../core/output-guard.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { type RpcEvent, RpcClient } from "../modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../modes/rpc/rpc-types.ts";
import { processTitle, setProcessTitle } from "../octocode/processes/title.ts";
import { homeFolderMessage, refusedFolderMessage } from "../octocode/trust/messages.ts";
import { resolveFolderTrust } from "../octocode/trust/resolve.ts";

const WORKER_EVENTS: ReadonlySet<string> = new Set<AcpWorkerEvent["type"]>([
	"session_dispatch",
	"agent_settled",
	"agent_end",
	"extension_error",
	"message_start",
	"message_update",
	"message_end",
	"auto_retry_start",
	"auto_retry_end",
	"compaction_start",
	"compaction_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isWorkerEvent(event: RpcEvent): event is Extract<RpcEvent, { type: AcpWorkerEvent["type"] }> {
	return WORKER_EVENTS.has(event.type);
}

/** Only dialogs a client can answer: status, widget, title and editor-text requests have no ACP counterpart. */
function isDialog(
	request: RpcExtensionUIRequest,
): request is Extract<RpcExtensionUIRequest, { method: AcpUiRequest["method"] }> {
	return ["select", "confirm", "input", "editor"].includes(request.method);
}

function createWorker(launch: AcpWorkerLaunch): AcpWorkerClient {
	const invocation = getCliInvocation();
	const client = new RpcClient({
		onSessionIdentity: launch.onSessionIdentity,
		cwd: launch.cwd,
		ownProcessTree: true,
		invocation: { command: invocation.command, args: invocation.prefix },
		args: launch.args,
		env: launch.env,
	});
	return {
		start: () => client.start(),
		stop: () => client.stop(),
		getState: () => client.getState(),
		persistSession: () => client.persistSession(),
		prompt: (...args) => client.prompt(...args),
		abort: () => client.abort(),
		onEvent: (listener) =>
			client.onEvent((event) => {
				if (isWorkerEvent(event)) listener(event);
			}),
		onClose: (listener) => client.onClose(listener),
		onExtensionUIRequest: (listener) =>
			client.onExtensionUIRequest((request) => {
				if (isDialog(request)) listener(request);
			}),
		respondToExtensionUIRequest: (response) => client.respondToExtensionUIRequest(response),
		getCommands: () => client.getCommands(),
	};
}

/** What the ACP workspace's inbound broker takes from this application (installed by `main.ts` for `--mode acp`). */
export const acpServerHost: AcpServerHost = {
	version: VERSION,
	sessionDirEnv: ENV_SESSION_DIR,
	agentDir: getAgentDir,
	nodeRuntime: () => (isBunBinary ? "node" : process.execPath),
	configuredSessionDir: (cwd) =>
		SettingsManager.createForStartup(cwd, undefined, resolveFolderTrust(cwd).state === "trusted").getSessionDir(),
	folderTrust(cwd) {
		const trust = resolveFolderTrust(cwd);
		if (trust.state === "trusted") return { trusted: true };
		const command = `octocode trust add ${trust.path}`;
		if (trust.state === "refused") return { trusted: false, message: refusedFolderMessage(trust.path), command };
		if (trust.state === "untrusted" && (trust.reason === "home" || trust.reason === "filesystem-root"))
			return { trusted: false, message: homeFolderMessage(trust.path, trust.reason), command };
		const why = trust.state === "untrusted" ? ` (${trust.reason})` : "";
		return { trusted: false, message: `Folder is not trusted: ${trust.path}${why}`, command };
	},
	listSessions: (cwd, sessionDir) =>
		cwd === undefined ? SessionManager.listAll(sessionDir) : SessionManager.list(cwd, sessionDir),
	openTranscript(path) {
		const manager = SessionManager.open(path);
		const branch: AcpTranscriptEntry[] = [];
		for (const entry of manager.getBranch()) {
			if (entry.type === "compaction")
				branch.push({ type: "compaction", id: entry.id, summary: entry.summary, tokensBefore: entry.tokensBefore });
			else if (entry.type === "message") branch.push({ type: "message", message: entry.message });
			else if (entry.type === "custom_message" && entry.display)
				branch.push({
					type: "message",
					message: createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
				});
		}
		return { sessionId: manager.getSessionId(), branch };
	},
	compactionSummaryText: (summary, tokensBefore) => compactionSummaryDisplay({ summary, tokensBefore }),
	stdout: { takeOver: takeOverStdout, write: writeRawStdoutAsync, flush: flushRawStdout },
	createWorker,
};

/** Runs `--mode acp`: the one place the inbound broker receives its host. */
export async function runAcpMain(args: string[], parsed: AcpLaunchOptions): Promise<void> {
	// The broker has no session to be named for, and it is not a main session: each of its workers is `octocode-rpc-<id>`.
	setProcessTitle(processTitle("acp", String(process.pid)));
	const { acpWorkerArguments, runAcpMode } = await import("../../../acp/src/server/acp-mode.ts");
	await runAcpMode(acpServerHost, acpWorkerArguments(args, parsed));
}
