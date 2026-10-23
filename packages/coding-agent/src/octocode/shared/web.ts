import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { openFile } from "./open.ts";

interface WebServer {
	url: string;
	close(): Promise<void>;
}

export function webLauncher(pi: ExtensionAPI, open = openFile) {
	let server: WebServer | undefined;
	let key = "";
	let pending = Promise.resolve();
	const enqueue = (action: () => Promise<void>) => {
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
	pi.on("session_start", close);
	pi.on("session_shutdown", close);
	return (sessionKey: string, start: () => Promise<WebServer>, view: "board" | "activity") =>
		enqueue(async () => {
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
			await open(url.href);
		});
}
