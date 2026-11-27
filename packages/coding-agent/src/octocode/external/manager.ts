import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FeatureContext } from "../../core/features/index.ts";
import { EXTERNAL_PROMPT_DEFAULT_MS } from "../api/protocol.ts";
import { apiDir, listInstances, matchInstances } from "../api/registry.ts";
import type { MessageEnvelope } from "../shared/messages.ts";
import type { ReferenceContext } from "../child-sessions/references.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AcpBackend, type AcpConnectInput, type AcpPermission } from "../../../../acp/src/client/client.ts";
import { connectAcp } from "./acp-host.ts";
import { runnerSessionMeta } from "./runner-isolation.ts";
import { selectedExternalAgent } from "./selection.ts";
import { type InstalledAcpAgent, installedAcpAgents } from "./discover.ts";
import { runnerSpec } from "./runners.ts";
import { OctocodeBackend } from "./octocode.ts";
import { expandPromptRefs } from "./refs.ts";
import type { ExternalBackend } from "@octocodeai/octocode-contracts/external";
import { type ExternalInfo, type ExternalParams, parseExternalParams } from "./protocol.ts";

export const MAX_EXTERNAL_CONNECTIONS = 8;
/** Model ids a connect result lists; the rest are counted in `modelsMore`. */
const MAX_LISTED_MODELS = 100;

/** A refusal before anything reached the external agent: `execution: "not-sent"` tells the model it may try again. */
function notSent(message: string): Error {
	return Object.assign(new Error(message), { execution: "not-sent" });
}

export interface ExternalPolicy {
	/** The selected vendors (`enabledExternalAgents`); undefined when none is configured: manual connections are not limited. */
	enabledRunners?: readonly string[];
	authorize(input: ExternalParams, ctx: FeatureContext, signal: AbortSignal): Promise<void>;
	beforeSend(message: MessageEnvelope, ctx: FeatureContext, signal?: AbortSignal): Promise<void>;
	afterReceive(message: MessageEnvelope, ctx: FeatureContext): Promise<void>;
	permission(ctx: FeatureContext): AcpPermission;
	sender(ctx: FeatureContext): string;
	/** What a prompt's `refs` resolve against; without it, a prompt with refs is refused. */
	references?(ctx: FeatureContext): ReferenceContext;
}

interface Connection {
	info: ExternalInfo;
	controller: AbortController;
	backend?: ExternalBackend;
	pending?: AbortController;
}

function isBusy(entry: Connection): boolean {
	return entry.info.busy || entry.backend?.isBusy === true;
}

/** The connection as callers see it: its current model is read from the backend, since the agent can change it. */
function view(entry: Connection): ExternalInfo {
	const model = entry.backend?.models?.current;
	return { ...entry.info, busy: isBusy(entry), ...(model ? { model } : {}) };
}

/** The model ids a newly connected agent accepts as `model` on a later connect. */
function offered(backend: ExternalBackend): { models?: string[]; modelsMore?: number } {
	const ids = backend.models?.available ?? [];
	if (!ids.length) return {};
	return {
		models: ids.slice(0, MAX_LISTED_MODELS),
		...(ids.length > MAX_LISTED_MODELS ? { modelsMore: ids.length - MAX_LISTED_MODELS } : {}),
	};
}

/** The folder a running instance works in: attaching to one by name states no folder, and the backend still verifies it. */
function attachedWorkspace(input: ExternalParams): string | undefined {
	if (input.transport !== "octocode" || !input.instanceId) return undefined;
	return matchInstances(listInstances(apiDir()), input.instanceId)[0]?.cwd;
}

/** The external destinations this process can advertise, excluding its own session API. */
function peerInstances(prune: boolean) {
	return listInstances(apiDir(), prune).filter((instance) => instance.pid !== process.pid);
}

export interface ExternalFactories {
	acp: (input: AcpConnectInput, permission: AcpPermission, signal?: AbortSignal) => Promise<AcpBackend>;
	octocode: typeof OctocodeBackend.connect;
	/** Installed ACP agents for `list`; PATH lookup when omitted. */
	discover?: () => InstalledAcpAgent[];
}

export class ExternalAgents {
	private readonly connections = new Map<string, Connection>();
	private lifetime = new AbortController();

	private readonly policy: ExternalPolicy;
	private readonly factories: ExternalFactories;
	constructor(policy: ExternalPolicy, factories: Partial<ExternalFactories> = {}) {
		this.policy = policy;
		this.factories = { acp: connectAcp, octocode: OctocodeBackend.connect, ...factories };
	}

	get running(): number {
		return [...this.connections.values()].filter(isBusy).length;
	}

	/**
	 * Whether there is anything to connect to: a known ACP agent on PATH, a selected vendor Octocode does not ship (the
	 * user's own ACP agent, connected by its command), or another live Octocode instance. The `agent`
	 * tool declares its `external` type only then, and only with the `externalAgents` setting on; `/agents external` stays available either way. Reads only; nothing is
	 * started or pruned.
	 */
	discoverable(): boolean {
		if (this.installed().length > 0) return true;
		// `octocode` is a selectable vendor too, but another Octocode counts only when it is live (below).
		if (this.policy.enabledRunners?.some((id) => id !== "octocode" && !runnerSpec(id))) return true;
		return peerInstances(false).length > 0;
	}

	private installed(): InstalledAcpAgent[] {
		return (this.factories.discover ?? installedAcpAgents)().filter((agent) =>
			selectedExternalAgent(this.policy.enabledRunners, agent.vendor, agent.command),
		);
	}

	async call(value: unknown, ctx: FeatureContext, callerSignal?: AbortSignal): Promise<unknown> {
		const input = parseExternalParams(value);
		for (const [id, entry] of this.connections) {
			if (entry.backend?.isClosed) this.connections.delete(id);
		}
		const signal = AbortSignal.any([
			this.lifetime.signal,
			...(ctx.signal ? [ctx.signal] : []),
			...(callerSignal ? [callerSignal] : []),
		]);
		signal.throwIfAborted();
		if (input.action === "list") {
			return {
				connections: [...this.connections.values()].map(view),
				instances: peerInstances(true).map(({ id, name, pid, cwd, protocol, session }) => ({
					id,
					name,
					pid,
					cwd,
					protocol,
					session,
				})),
				acpAgents: this.installed(),
			};
		}
		if (input.action === "connect") return this.connect(input, ctx, signal);
		const entry = this.connections.get(input.id!);
		if (!entry) throw new Error(`Unknown external connection ${input.id}. Use list, then connect explicitly.`);
		if (input.action === "disconnect") {
			this.connections.delete(input.id!);
			entry.controller.abort(new Error("External connection disconnected"));
			await entry.backend?.close();
			return { disconnected: input.id };
		}
		if (input.action === "cancel") {
			entry.pending?.abort(new Error("External prompt cancelled"));
			await entry.backend?.cancel();
			return { cancelled: input.id };
		}
		if (!entry.backend) throw notSent("External connection is still starting.");
		if (isBusy(entry)) throw notSent("External connection already has a prompt in flight.");
		entry.info.busy = true;
		const pending = new AbortController();
		entry.pending = pending;
		try {
			const promptSignal = AbortSignal.any([signal, entry.controller.signal, pending.signal]);
			const id = randomUUID();
			const from = this.policy.sender(ctx);
			// Expanded first, so the send hooks, the permission dialog and the peer all see the same text.
			const text = await this.expand(input, ctx);
			promptSignal.throwIfAborted();
			await this.policy.beforeSend(
				{ channel: "external", direction: "outbound", from, to: entry.info.id, text, id },
				ctx,
				promptSignal,
			);
			promptSignal.throwIfAborted();
			await this.policy.authorize(
				{
					...input,
					text,
					cwd: entry.info.cwd,
					transport: entry.info.transport,
					vendor: entry.info.vendor,
					sessionId: entry.info.sessionId,
				},
				ctx,
				promptSignal,
			);
			promptSignal.throwIfAborted();
			let reply: Awaited<ReturnType<typeof entry.backend.prompt>>;
			try {
				reply = await entry.backend.prompt(text, {
					timeoutMs: input.timeoutMs ?? EXTERNAL_PROMPT_DEFAULT_MS,
					signal: promptSignal,
					key: id,
				});
			} catch (error) {
				if (
					entry.info.transport === "acp" &&
					entry.backend.isClosed !== false &&
					this.connections.get(entry.info.id) === entry
				) {
					this.connections.delete(entry.info.id);
					await entry.backend.close();
				}
				throw error;
			}
			let receiveHookError: string | undefined;
			try {
				await this.policy.afterReceive(
					{
						channel: "external",
						direction: "inbound",
						from: entry.info.id,
						to: from,
						text: reply.text,
						id: randomUUID(),
						replyTo: id,
					},
					ctx,
				);
			} catch (error) {
				receiveHookError = errorMessage(error);
			}
			return {
				...view(entry),
				busy: false,
				messageId: id,
				reply,
				...(receiveHookError ? { receiveHookError } : {}),
			};
		} finally {
			entry.info.busy = false;
			if (entry.pending === pending) entry.pending = undefined;
		}
	}

	/** The prompt text with its refs' content appended; a refusal here is not-sent. */
	private async expand(input: ExternalParams, ctx: FeatureContext): Promise<string> {
		if (!input.refs?.length) return input.text!;
		if (!this.policy.references) throw notSent("refs are unavailable in this session; nothing was sent.");
		try {
			return await expandPromptRefs(input.text!, input.refs, this.policy.references(ctx));
		} catch (error) {
			throw notSent(errorMessage(error));
		}
	}

	private async connect(
		input: ExternalParams,
		ctx: FeatureContext,
		signal: AbortSignal,
	): Promise<ExternalInfo & { models?: string[]; modelsMore?: number }> {
		if (input.transport === "acp" && !selectedExternalAgent(this.policy.enabledRunners, input.vendor!, input.command!))
			throw notSent(
				`External agent ${input.vendor} is not enabled for this command. Select it in /providers, then /reload.`,
			);
		const id = input.id ?? randomUUID();
		if (this.connections.has(id)) throw new Error(`External connection ${id} already exists.`);
		if (this.connections.size >= MAX_EXTERNAL_CONNECTIONS)
			throw new Error(
				`External connection limit (${MAX_EXTERNAL_CONNECTIONS}) reached. Disconnect one before connecting another.`,
			);
		const cwd = realpathSync(path.resolve(ctx.cwd, input.cwd ?? attachedWorkspace(input) ?? "."));
		if (!statSync(cwd).isDirectory()) throw new Error("External cwd must be a directory.");
		const entry: Connection = {
			info: {
				id,
				transport: input.transport!,
				vendor: input.transport === "octocode" ? "octocode" : input.vendor!,
				cwd,
				sessionId: "",
				busy: true,
			},
			controller: new AbortController(),
		};
		this.connections.set(id, entry);
		const startup = AbortSignal.any([signal, entry.controller.signal]);
		try {
			await this.policy.authorize({ ...input, cwd }, ctx, startup);
			startup.throwIfAborted();
			const backend =
				input.transport === "octocode"
					? await this.factories.octocode({ instanceId: input.instanceId!, cwd })
					: await this.factories.acp(
							{
								command: input.command!,
								args: input.args,
								vendor: input.vendor!,
								sessionMeta: runnerSessionMeta(input.vendor!),
								cwd,
								sessionId: input.sessionId,
								model: input.model,
								timeoutMs: input.timeoutMs,
							},
							this.policy.permission(ctx),
							startup,
						);
			entry.backend = backend;
			startup.throwIfAborted();
			entry.info.sessionId = backend.sessionId;
			entry.info.busy = false;
			return { ...view(entry), ...offered(backend) };
		} catch (error) {
			if (this.connections.get(id) === entry) this.connections.delete(id);
			await entry.backend?.close();
			throw error;
		}
	}

	async reset(): Promise<void> {
		this.lifetime.abort(new Error("Octocode session or permission scope changed"));
		this.lifetime = new AbortController();
		const entries = [...this.connections.values()];
		this.connections.clear();
		for (const entry of entries) entry.controller.abort(new Error("External connection closed"));
		await Promise.allSettled(entries.flatMap((entry) => entry.backend?.close() ?? []));
	}
}
