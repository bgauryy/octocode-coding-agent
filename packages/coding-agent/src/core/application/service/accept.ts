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

/** What accepting a command reads and calls on its service. */
export interface AcceptCommandHost {
	state: ApplicationStateStore;
	assets: ApplicationAssets;
	session: ApplicationSession;
	receiptStore: ApplicationReceiptStore | undefined;
	currentSession: string;
	isOpen: () => boolean;
	sessionId: () => string;
	publish: (event: ApplicationEvent) => void;
	publishDomain: (event: ApplicationEvent) => void;
	reportFailure: (error: ApplicationServiceError) => void;
}

/** Validate, deduplicate and receipt one command, then dispatch it to the session without waiting for it. */
export function acceptApplicationCommand(command: ApplicationCommand, host: AcceptCommandHost): ApplicationReceipt {
	const { state, session, receiptStore } = host;
	if (!Value.Check(ApplicationCommandSchema, command)) throw new Error("Invalid application command");
	if (command.sessionId !== host.currentSession) throw new Error("Session changed");
	const fingerprint = applicationCommandFingerprint(command);
	const previous = state.getState().receipts.get(command.id);
	if (previous) {
		if (previous.fingerprint !== fingerprint) throw new Error("Request ID already used with another command");
		return { ...previous.receipt };
	}
	if (command.action === "abort" && command.runId !== state.getState().runId) throw new Error("Run changed");
	const images = commandImages(command, host.assets, session);
	reserveReceipt(state);
	const recorded = receiptStore?.begin(command);
	if (recorded && !recorded.fresh) return recorded.receipt;
	const receipt: ApplicationReceipt = recorded?.receipt ?? { id: command.id, status: "accepted" };
	state.setState(({ receipts }) => ({
		receipts: new Map(receipts).set(command.id, { fingerprint, receipt: { ...receipt } }),
	}));
	host.publish({ type: "command.receipt", receipt: { ...receipt } });
	const sessionAtDispatch = host.currentSession;
	dispatchCommand({
		command,
		receipt,
		receiptStore,
		isCurrent: () => host.isOpen() && host.sessionId() === sessionAtDispatch,
		runId: () => state.getState().runId,
		invoke: () => {
			if (!host.isOpen()) throw new Error("Application service is closed");
			return invokeCommand(command, images, session);
		},
		publishDomain: host.publishDomain,
		reportFailure: host.reportFailure,
	});
	return { ...receipt };
}
