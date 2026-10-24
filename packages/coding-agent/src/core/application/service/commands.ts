import {
	APPLICATION_IMAGE_MIME_TYPES,
	type ApplicationCommand,
	type ApplicationEvent,
	type ApplicationReceipt,
} from "@octocodeai/octocode-contacts";
import { redactSecrets } from "../../../octocode/shared/sanitize.ts";
import type { ApplicationReceiptStore } from "./types.ts";
import type { ImageContent } from "@octocodeai/octocode-ai";
import type { ApplicationAssets } from "../assets.ts";

/** Resolve attachment references before accepting a command, while the current session still owns them. */
export function commandImages(command: ApplicationCommand, assets: ApplicationAssets): ImageContent[] | undefined {
	if (command.action === "abort") return undefined;
	if (!command.text.trim() && !command.attachments?.length) throw new Error("Enter a message or attach an image");
	if (!command.attachments?.length) return undefined;
	return command.attachments.map((id) => {
		const payload = assets.get(id);
		if (
			!payload ||
			payload.encoding !== "base64" ||
			!APPLICATION_IMAGE_MIME_TYPES.some((mimeType) => mimeType === payload.asset.mimeType)
		)
			throw new Error("Image attachment is unavailable in this session");
		return { type: "image", data: payload.data, mimeType: payload.asset.mimeType };
	});
}

/** What dispatching an accepted command needs of the application service. */
export interface CommandDispatch {
	command: ApplicationCommand;
	/** Updated in place with the outcome. */
	receipt: ApplicationReceipt;
	receiptStore?: ApplicationReceiptStore;
	/** False once the service closed or its session changed since the command was accepted. */
	isCurrent(): boolean;
	runId(): string | undefined;
	/** Call the session operation the command names. */
	invoke(): unknown;
	publishDomain(event: ApplicationEvent): void;
}

/** Run the command after the current call returns, then record and publish its outcome while the session is current. */
export function dispatchCommand(dispatch: CommandDispatch): void {
	const { command, receipt, receiptStore } = dispatch;
	const work = Promise.resolve().then<unknown>(() => {
		if (!dispatch.isCurrent()) throw new Error("Session changed before dispatch");
		if (command.action === "abort" && command.runId !== dispatch.runId())
			throw new Error("Run changed before dispatch");
		return dispatch.invoke();
	});
	Promise.resolve(work)
		.then(
			() => {
				if (!dispatch.isCurrent()) return;
				receipt.status = "completed";
				receiptStore?.finish(command.id, "completed");
				dispatch.publishDomain({
					type: "command.receipt",
					receipt: { ...receipt },
				});
			},
			(error) => {
				if (!dispatch.isCurrent()) return;
				receipt.status = "failed";
				receipt.message = error instanceof Error ? redactSecrets(error.message).slice(0, 1000) : "Command failed";
				receiptStore?.finish(command.id, "failed", receipt.message);
				dispatch.publishDomain({
					type: "command.receipt",
					receipt: { ...receipt },
				});
			},
		)
		.catch((error) => {
			console.error("Application receipt persistence failed", error);
			if (dispatch.isCurrent()) {
				receipt.status = "failed";
				receipt.message = "Command outcome could not be persisted; inspect the session before retrying.";
				dispatch.publishDomain({
					type: "command.receipt",
					receipt: { ...receipt },
				});
			}
		});
}
