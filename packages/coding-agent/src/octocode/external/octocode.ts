import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiCallError, ApiClient } from "../api/client.ts";
import { ERR, MESSAGE_KEY_MAX, PROTOCOL_VERSION } from "../api/protocol.ts";
import { apiDir, listInstances, selectInstance } from "../api/registry.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ExternalBackend, ExternalReply } from "@octocodeai/octocode-contracts/external";
import { PROMPT_TIMEOUT_MS, promptTimeoutValid } from "./protocol.ts";

/** How long a status, initialize or abort call to the Octocode instance may take. */
const API_CALL_MS = 10_000;

function canonical(cwd: string): string {
	if (!path.isAbsolute(cwd)) throw new Error("Octocode workspace must be an absolute directory");
	try {
		const real = fs.realpathSync(cwd);
		if (!fs.statSync(real).isDirectory()) throw new Error("Not a directory");
		return real;
	} catch {
		throw new Error("Octocode workspace is not an accessible directory");
	}
}

export class OctocodeBackend implements ExternalBackend {
	private closed = false;
	private inFlight = false;
	private owned: { key: string; text: string } | undefined;
	private controller: AbortController | undefined;
	private cancelling: Promise<void> | undefined;

	private readonly client: ApiClient;
	private readonly caller: Record<string, unknown>;
	readonly sessionId: string;
	readonly cwd: string;
	private constructor(client: ApiClient, caller: Record<string, unknown>, sessionId: string, cwd: string) {
		this.client = client;
		this.caller = caller;
		this.sessionId = sessionId;
		this.cwd = cwd;
	}

	static async connect(
		input: { instanceId: string; cwd: string },
		env: NodeJS.ProcessEnv = process.env,
	): Promise<OctocodeBackend> {
		const cwd = canonical(input.cwd);
		const instance = selectInstance(listInstances(apiDir(env)), input.instanceId);
		if (instance.protocol !== PROTOCOL_VERSION)
			throw new Error(
				`Octocode instance ${instance.id} speaks API protocol ${instance.protocol}, not ${PROTOCOL_VERSION}`,
			);
		if (canonical(instance.cwd) !== cwd)
			throw new Error(`Octocode instance ${instance.id} workspace mismatch: it runs in ${instance.cwd}, not ${cwd}`);
		if (instance.socket !== undefined) {
			let valid = false;
			try {
				valid =
					typeof instance.socket === "string" &&
					path.isAbsolute(instance.socket) &&
					fs.lstatSync(instance.socket).isSocket();
			} catch {
				/* Refuse a stale or invalid discovery record. */
			}
			if (!valid) throw new Error("Octocode instance socket is not an existing local socket");
		}
		if (
			instance.http !== undefined &&
			(!isRecord(instance.http) ||
				typeof instance.http.url !== "string" ||
				typeof instance.http.token !== "string" ||
				!instance.http.token)
		) {
			throw new Error("Octocode instance HTTP transport is invalid");
		}
		const client = new ApiClient(instance);
		const initialized = await client.call("initialize", {}, { timeoutMs: API_CALL_MS });
		if (!isRecord(initialized) || initialized.protocolVersion !== PROTOCOL_VERSION || !isRecord(initialized.instance))
			throw new Error("Octocode initialization protocol mismatch");
		const peer = initialized.instance;
		if (
			peer.id !== instance.id ||
			peer.pid !== instance.pid ||
			typeof peer.cwd !== "string" ||
			canonical(peer.cwd) !== cwd
		)
			throw new Error("Octocode initialization identity or workspace mismatch");
		if (!isRecord(initialized.capabilities) || initialized.capabilities.wait !== true)
			throw new Error("Octocode instance does not support run settlement");
		const status = await client.call("status", {}, { timeoutMs: API_CALL_MS });
		if (
			!isRecord(status) ||
			typeof status.sessionId !== "string" ||
			!status.sessionId ||
			typeof status.cwd !== "string" ||
			canonical(status.cwd) !== cwd
		) {
			throw new Error("Octocode live session or workspace mismatch");
		}
		const own = listInstances(apiDir(env), false).find((entry) => entry.pid === process.pid);
		const caller = {
			pid: process.pid,
			cwd: own?.cwd ?? process.cwd(),
			...(own ? { instanceId: own.id, name: own.name } : {}),
		};
		return new OctocodeBackend(client, caller, status.sessionId, cwd);
	}

	private async status(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
		if (this.closed) throw new Error("Octocode connection is closed");
		const status = await this.client.call("status", {}, { timeoutMs: API_CALL_MS, ...options });
		if (
			!isRecord(status) ||
			status.sessionId !== this.sessionId ||
			typeof status.cwd !== "string" ||
			canonical(status.cwd) !== this.cwd
		) {
			throw new Error("The connected Octocode session or workspace was replaced");
		}
		return status;
	}

	async prompt(
		text: string,
		options: { timeoutMs: number; signal?: AbortSignal; key?: string },
	): Promise<ExternalReply> {
		if (this.closed) throw new Error("Octocode connection is closed");
		if (this.cancelling) throw new Error("This Octocode connection has a cancellation in progress");
		if (this.inFlight) throw new Error("This Octocode connection already has a prompt in flight");
		if (!text.trim()) throw new Error("Octocode prompt text must be non-empty");
		if (!promptTimeoutValid(options.timeoutMs))
			throw new Error(`Octocode prompt timeoutMs must be from ${PROMPT_TIMEOUT_MS.min} to ${PROMPT_TIMEOUT_MS.max}`);
		const key = options.key ?? randomUUID();
		if (!key.trim() || key.length > MESSAGE_KEY_MAX)
			throw new Error(`Octocode prompt key must have from 1 to ${MESSAGE_KEY_MAX} characters`);
		if (this.owned && (this.owned.key !== key || this.owned.text !== text))
			throw new Error(
				"An earlier Octocode request may still be running; cancel it before prompting again (a direct client may instead retry with the same key and text)",
			);
		if (options.signal?.aborted) throw new Error("Octocode prompt aborted");
		this.inFlight = true;
		const controller = new AbortController();
		this.controller = controller;
		const abort = (): void => {
			controller.abort();
			void this.cancel().catch(() => undefined);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		let attempted = false;
		try {
			const status = await this.status({
				timeoutMs: Math.min(options.timeoutMs, API_CALL_MS),
				signal: controller.signal,
			});
			if (!this.owned && (status.state !== "idle" || status.pending !== false || status.activeMessageId !== undefined))
				throw new Error("Octocode session is busy; nothing was sent");
			this.owned = { key, text };
			attempted = true;
			const reply = await this.client.call(
				"message.send",
				{
					text,
					from: "Octocode external adapter",
					caller: this.caller,
					expectedSessionId: this.sessionId,
					requireIdle: true,
					key,
					wait: true,
					timeoutMs: options.timeoutMs,
				},
				{ timeoutMs: options.timeoutMs + 1000, signal: controller.signal },
			);
			if (!isRecord(reply) || typeof reply.text !== "string" || typeof reply.id !== "string")
				throw new Error("Invalid Octocode run settlement response");
			if (reply.stopReason !== undefined && typeof reply.stopReason !== "string")
				throw new Error("Invalid Octocode stop reason");
			this.owned = undefined;
			return {
				text: reply.text,
				...(typeof reply.stopReason === "string" ? { stopReason: reply.stopReason } : {}),
				remoteMessageId: reply.id,
			};
		} catch (error) {
			const data = error instanceof ApiCallError && isRecord(error.data) ? error.data : {};
			// A local refusal before the send (an oversized frame, a bad timeout) names itself; nothing is running for it.
			const local = !(error instanceof ApiCallError) ? (error as { execution?: unknown }).execution : undefined;
			if (local === "not-sent") this.owned = undefined;
			if (
				error instanceof ApiCallError &&
				error.code !== ERR.timeout &&
				!["accepted", "uncertain", "unknown"].includes(String(data.execution))
			)
				this.owned = undefined;
			if (error instanceof Error) {
				const execution =
					data.execution ??
					local ??
					(error instanceof ApiCallError && error.code === ERR.timeout
						? "accepted"
						: attempted
							? "unknown"
							: "not-sent");
				Object.assign(error, { execution });
			}
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			this.inFlight = false;
			this.controller = undefined;
		}
	}

	cancel(): Promise<void> {
		if (this.cancelling) return this.cancelling;
		const pending = this.cancelOwned().finally(() => {
			if (this.cancelling === pending) this.cancelling = undefined;
		});
		this.cancelling = pending;
		return pending;
	}

	private async cancelOwned(): Promise<void> {
		const owned = this.owned;
		if (!owned) {
			this.controller?.abort();
			return;
		}
		const status = await this.status();
		if (status.activeMessageId === undefined) {
			this.owned = undefined;
			return;
		}
		await this.client.call(
			"turn.abort",
			{ expectedSessionId: this.sessionId, key: owned.key },
			{ timeoutMs: API_CALL_MS },
		);
		this.owned = undefined;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		try {
			await this.cancel();
		} finally {
			this.closed = true;
			this.controller?.abort();
		}
	}
}
