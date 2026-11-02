import type { ExtensionAPI } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openFile } from "./open.ts";

interface WebServer {
	url: string;
	close(): Promise<void>;
	validate?: () => Promise<boolean>;
}

export function webLauncher(api: ExtensionAPI, open = openFile) {
	let server: WebServer | undefined;
	let key = "";
	let pending: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
		const next = pending.then(action);
		pending = next.catch(() => undefined);
		return next;
	};
	const close = () =>
		enqueue(async () => {
			const previous = server;
			server = undefined;
			await previous?.close();
		});
	api.on("session_start", close);
	api.on("session_shutdown", close);
	return (sessionKey: string, start: () => Promise<WebServer>, view: "board" | "activity") =>
		enqueue(async () => {
			if (server && !((await server.validate?.().catch(() => false)) ?? true)) {
				const previous = server;
				server = undefined;
				await previous.close();
			}
			if (!server || key !== sessionKey) {
				const previous = server;
				server = undefined;
				await previous?.close();
				server = await start();
				key = sessionKey;
			}
			const url = new URL(server.url);
			const fragment = new URLSearchParams(url.hash.slice(1));
			fragment.set("view", view);
			url.hash = fragment.toString();
			try {
				await open(url.href);
			} catch (error) {
				// The server is running: give the address, so a headless or SSH session can still reach it.
				throw new Error(`no browser could be started (${errorMessage(error)}); open ${url.href}`);
			}
			return url.href;
		});
}
