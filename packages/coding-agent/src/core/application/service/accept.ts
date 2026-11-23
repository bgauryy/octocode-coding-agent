import { Value } from "typebox/value";
import {
	ApplicationCommandSchema,
	applicationCommandFingerprint,
	type ApplicationCommand,
	type ApplicationEvent,
	type ApplicationReceipt,
} from "@octocodeai/octocode-contracts";
import type { ApplicationAssets } from "../assets.ts";
import type { ApplicationSession } from "../session-port.ts";
import { reserveReceipt, type ApplicationStateStore } from "../state.ts";
import type { ApplicationServiceError } from "./delivery.ts";
import { commandImages, dispatchCommand, invokeCommand } from "./commands.ts";
import type { ApplicationReceiptStore } from "./types.ts";

/** A command whose durable receipt is being recorded: a repeat of it waits for the same acceptance. */
export interface RecordingCommand {
	fingerprint: string;
	accepted: Promise<ApplicationReceipt>;
}

/** What accepting a command reads and calls on its service. */
export interface AcceptCommandHost {
	state: ApplicationStateStore;
	assets: ApplicationAssets;
	session: ApplicationSession;
	receiptStore: ApplicationReceiptStore | undefined;
	/** Commands whose durable receipt is being recorded, by id; owned by the service. */
	recording: Map<string, RecordingCommand>;
	/** Runs `work` in the service's delivery order, after any delivery in progress. */
	deliver: <T>(work: () => T) => Promise<T>;
	currentSession: () => string;
	isOpen: () => boolean;
	sessionId: () => string;
	publish: (event: ApplicationEvent) => void;
	publishDomain: (event: ApplicationEvent) => void;
	reportFailure: (error: ApplicationServiceError) => void;
	/** Publish the session's model and spend now: a model command's outcome reaches clients before its receipt does. */
	syncFacts: () => void;
}

/**
 * Validate, deduplicate and receipt one command, then dispatch it to the session without waiting for it. The durable
 * receipt is recorded first; while another process holds the database that wait yields the thread, and the command is
 * admitted only if the service is still open on the same session afterwards.
 */
export async function acceptApplicationCommand(
	command: ApplicationCommand,
	host: AcceptCommandHost,
): Promise<ApplicationReceipt> {
	return host.deliver((): ApplicationReceipt | Promise<ApplicationReceipt> => {
		const { state, receiptStore } = host;
		if (!Value.Check(ApplicationCommandSchema, command)) throw new Error("Invalid application command");
		if (command.sessionId !== host.currentSession()) throw new Error("Session changed");
		const fingerprint = applicationCommandFingerprint(command);
		const previous = state.getState().receipts.get(command.id) ?? host.recording.get(command.id);
		if (previous && previous.fingerprint !== fingerprint)
			throw new Error("Request ID already used with another command");
		if (previous && "receipt" in previous) return { ...previous.receipt };
		if (previous) return previous.accepted.then((receipt) => ({ ...receipt }));
		if (command.action === "abort" && command.runId !== state.getState().runId) throw new Error("Run changed");
		const images = commandImages(command, host.assets, host.session);
		reserveReceipt(state, host.recording.size);
		if (!receiptStore) return admit(command, fingerprint, images, { id: command.id, status: "accepted" }, host);
		const accepted = receiptStore
			.begin(command)
			.then((recorded) =>
				host.deliver(() => {
					if (!host.isOpen()) throw new Error("Application service is closed");
					if (command.sessionId !== host.currentSession()) throw new Error("Session changed");
					if (!recorded.fresh) return recorded.receipt;
					return admit(command, fingerprint, images, recorded.receipt, host);
				}),
			)
			.finally(() => host.recording.delete(command.id));
		host.recording.set(command.id, { fingerprint, accepted });
		return accepted.then((receipt) => ({ ...receipt }));
	});
}

/** Publish the accepted receipt and dispatch the command; the receipt as returned to the caller. */
function admit(
	command: ApplicationCommand,
	fingerprint: string,
	images: ReturnType<typeof commandImages>,
	receipt: ApplicationReceipt,
	host: AcceptCommandHost,
): ApplicationReceipt {
	const { state, session, receiptStore } = host;
	state.setState(({ receipts }) => ({
		receipts: new Map(receipts).set(command.id, { fingerprint, receipt: { ...receipt } }),
	}));
	host.publish({ type: "command.receipt", receipt: { ...receipt } });
	const sessionAtDispatch = host.currentSession();
	dispatchCommand({
		command,
		receipt,
		receiptStore,
		isCurrent: () => host.isOpen() && host.sessionId() === sessionAtDispatch,
		runId: () => state.getState().runId,
		invoke: () => {
			if (!host.isOpen()) throw new Error("Application service is closed");
			const result = invokeCommand(command, images, session);
			if (command.action !== "setModel" && command.action !== "setThinking") return result;
			return Promise.resolve(result).then(host.syncFacts);
		},
		publishDomain: host.publishDomain,
		reportFailure: host.reportFailure,
	});
	return { ...receipt };
}
