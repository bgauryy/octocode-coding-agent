import type { BoundMcpHookCaller } from "../../../../mcp/src/hook-caller.ts";
import { type HookMcp, HOOK_OUTPUT_MAX_BYTES, type HookRun } from "./contracts.ts";
import { stringOrEmpty } from "../shared/util.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";

function substitute(value: unknown, payload: Record<string, unknown>, codex: boolean): unknown {
	const resolve = (path: string): unknown => {
		let found: unknown = payload;
		for (const key of path.split(".")) found = isRecord(found) && Object.hasOwn(found, key) ? found[key] : undefined;
		if (codex && found === undefined) throw new Error(`hook input placeholder \`\${${path}}\` was not found`);
		return found;
	};
	if (typeof value === "string") {
		const whole = codex ? /^\$\{([^{}]+)\}$/.exec(value) : null;
		if (whole) return structuredClone(resolve(whole[1]));
		return value.replace(codex ? /\$\{([^{}]+)\}/g : /\$\{([^}]+)\}/g, (_match, path: string) => {
			const found = resolve(path);
			return found === undefined ? "" : typeof found === "string" ? found : JSON.stringify(found);
		});
	}
	if (Array.isArray(value)) return value.map((item) => substitute(item, payload, codex));
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, payload, codex)]));
	return value;
}

export async function runMcpHook(
	hook: HookMcp,
	payload: Record<string, unknown>,
	signal: AbortSignal | undefined,
	call: BoundMcpHookCaller | undefined,
): Promise<HookRun> {
	const empty: HookRun = {
		code: null,
		stdout: "",
		stderr: "",
		timedOut: false,
	};
	if (signal?.aborted) return empty;
	if (
		hook.protocol !== "codex" &&
		payload.hook_event_name === "SessionStart" &&
		!["clear", "compact"].includes(String(payload.source))
	)
		return { ...empty, code: 0 };
	if (!call) return { ...empty, stderr: "MCP hook owner is unavailable" };
	const abort = new AbortController();
	let timedOut = false;
	let rejectCancelled: (error: Error) => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectCancelled = reject;
	});
	const cancel = () => {
		abort.abort();
		rejectCancelled(new Error("MCP hook cancelled"));
	};
	signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		cancel();
	}, hook.timeoutMs);
	try {
		const event = stringOrEmpty(payload.hook_event_name);
		const result = await Promise.race([
			call({
				server: hook.server,
				tool: hook.tool,
				input: substitute(hook.input, payload, hook.protocol === "codex") as Record<string, unknown>,
				signal: abort.signal,
				waitForConnection: hook.protocol !== "codex" && !["Notification", "SessionEnd", "PostCompact"].includes(event),
			}),
			cancelled,
		]);
		if (result.isError) return { ...empty, stderr: "MCP tool returned an error" };
		const text = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		if (Buffer.byteLength(text) > HOOK_OUTPUT_MAX_BYTES)
			return { ...empty, stderr: "MCP hook response exceeds 64 KiB" };
		return { ...empty, code: 0, stdout: text };
	} catch (error) {
		return {
			...empty,
			timedOut,
			stderr: signal?.aborted ? "" : errorMessage(error),
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
