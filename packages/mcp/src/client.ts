import { IncomingRequests } from "./client/incoming.ts";
import { PendingRequests } from "./client/pending.ts";
import {
	isResource,
	isResourceTemplate,
	isTool,
	type ListRequest,
	listAll,
	listPage,
	pageCursor,
	toResource,
	toResourceTemplate,
	validateCallToolResult,
	validateInitializeResult,
	validateReadResourceResult,
} from "./client/results.ts";
import type {
	ClientState,
	CloseListener,
	ErrorListener,
	McpClientOptions,
	McpRequestOptions,
	NotificationListener,
	RequestHandler,
} from "./client/types.ts";
import type { CallToolResult, Resource } from "./protocol/content.ts";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isObject,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpConnectionClosedError,
	McpError,
	toError,
	McpAbortError,
} from "./protocol/jsonrpc.ts";
import {
	type ClientCapabilities,
	type Implementation,
	type InitializeResult,
	LATEST_PROTOCOL_VERSION,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type ReadResourceResult,
	type ResourceTemplate,
	type ServerCapabilities,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Tool,
} from "./protocol/types.ts";
import type { McpTransport } from "./transports/transport.ts";

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private serverInfoValue: Implementation | undefined;
	private serverCapabilitiesValue: ServerCapabilities | undefined;
	private instructionsValue: string | undefined;
	private protocolVersionValue: string | undefined;
	private pending = new PendingRequests({
		sendCancelled: (id, reason) => this.sendCancelled(id, reason),
		emitError: (error) => this.emitError(error),
	});
	private incoming = new IncomingRequests((error) => this.emitError(error));
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<ErrorListener>();
	private closeListeners = new Set<CloseListener>();
	private disposers: (() => void)[] = [];
	/** Pagination requests go through `request`. */
	private readonly list: ListRequest = (method, params, options) => this.request(method, params, options);

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.incoming.setHandler("ping", () => ({}));
		const roots = options.roots;
		if (roots) {
			this.incoming.setHandler("roots/list", async () => ({
				roots: [...(typeof roots === "function" ? await roots() : roots)],
			}));
		}
	}

	get connectionState(): ClientState {
		return this.state;
	}

	get serverInfo(): Implementation | undefined {
		return this.serverInfoValue;
	}

	get serverCapabilities(): ServerCapabilities | undefined {
		return this.serverCapabilitiesValue;
	}

	get instructions(): string | undefined {
		return this.instructionsValue;
	}

	get protocolVersion(): string | undefined {
		return this.protocolVersionValue;
	}

	async connect(transport: McpTransport): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.disposers = [
			transport.onMessage((message) => this.handleMessage(message)),
			// Transport errors are reported only. Pending requests fail when the transport closes.
			transport.onError((error) => this.emitError(error)),
			transport.onClose(() => this.handleTransportClose()),
		];

		try {
			await transport.start();
			const capabilities: ClientCapabilities = { ...this.options.capabilities };
			if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
			const result = validateInitializeResult(
				await this.requestInternal(
					"initialize",
					{
						protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
						capabilities,
						clientInfo: {
							name: this.options.name,
							version: this.options.version,
							...(this.options.title === undefined ? {} : { title: this.options.title }),
						},
					},
					{},
					true,
				),
			);
			if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
				throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
			}
			this.protocolVersionValue = result.protocolVersion;
			this.serverInfoValue = result.serverInfo;
			this.serverCapabilitiesValue = result.capabilities;
			this.instructionsValue = result.instructions;
			transport.setProtocolVersion?.(result.protocolVersion);
			await this.notifyInternal("notifications/initialized", undefined, true);
			// close() may have run while the notification was being sent; it wins over finishing the connect.
			if ((this.state as ClientState) === "closed")
				throw new McpConnectionClosedError("MCP client closed while connecting");
			this.state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return this.requestInternal(method, params, options, false) as Promise<Result>;
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.notifyInternal(method, params, false);
	}

	setRequestHandler(method: string, handler: RequestHandler): () => void {
		return this.incoming.setHandler(method, handler);
	}

	onNotification(method: string, listener: NotificationListener): () => void {
		const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
		this.notificationListeners.set(method, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.notificationListeners.delete(method);
		};
	}

	onError(listener: ErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Called once when the connection closes, whether the transport dropped or `close()` was called. */
	onClose(listener: CloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async ping(options: McpRequestOptions = {}): Promise<void> {
		await this.request("ping", undefined, options);
	}

	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		return (await listAll(this.list, "tools/list", "tools", isTool, options)) as unknown as Tool[];
	}

	/** Every resource, following `nextCursor` through all pages. */
	async listResources(options: McpRequestOptions = {}): Promise<Resource[]> {
		return (await listAll(this.list, "resources/list", "resources", isResource, options)).map(toResource);
	}

	/** One page of resources, starting at `cursor`. */
	async listResourcesPage(cursor?: string, options: McpRequestOptions = {}): Promise<ListResourcesResult> {
		const page = await listPage(this.list, "resources/list", "resources", isResource, cursor, options);
		return { resources: page.items.map(toResource), ...pageCursor(page) };
	}

	/** Every resource template, following `nextCursor` through all pages. */
	async listResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
		const templates = await listAll(
			this.list,
			"resources/templates/list",
			"resourceTemplates",
			isResourceTemplate,
			options,
		);
		return templates.map(toResourceTemplate);
	}

	/** One page of resource templates, starting at `cursor`. */
	async listResourceTemplatesPage(
		cursor?: string,
		options: McpRequestOptions = {},
	): Promise<ListResourceTemplatesResult> {
		const page = await listPage(
			this.list,
			"resources/templates/list",
			"resourceTemplates",
			isResourceTemplate,
			cursor,
			options,
		);
		return { resourceTemplates: page.items.map(toResourceTemplate), ...pageCursor(page) };
	}

	async readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
		return validateReadResourceResult(await this.request("resources/read", { uri }, options));
	}

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		return validateCallToolResult(
			await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
		);
	}

	async close(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.disposeTransportListeners();
		this.markClosed(new McpConnectionClosedError());
		await transport?.close();
	}

	private async requestInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		allowConnecting: boolean,
	): Promise<unknown> {
		const transport = this.requireTransport(allowConnecting);
		if (options.signal?.aborted) throw new McpAbortError();
		const id = this.nextRequestId++;
		const progressToken = options.onProgress ? id : undefined;
		const requestParams =
			progressToken === undefined
				? params
				: { ...params, _meta: { ...(isObject(params?._meta) ? params._meta : {}), progressToken } };
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(requestParams === undefined ? {} : { params: requestParams }),
		};
		return this.pending.start(id, method, options, progressToken, this.options, (signal) =>
			transport.send(message, { signal }),
		);
	}

	private async notifyInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		allowConnecting: boolean,
	): Promise<void> {
		await this.requireTransport(allowConnecting).send({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params }),
		});
	}

	private requireTransport(allowConnecting: boolean): McpTransport {
		if (this.transport && (this.state === "connected" || (allowConnecting && this.state === "connecting"))) {
			return this.transport;
		}
		throw new McpConnectionClosedError(`MCP client is ${this.state}`);
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (isJsonRpcResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (isJsonRpcRequest(message)) {
			const transport = this.transport;
			if (transport) void this.incoming.handle(message, transport);
			return;
		}
		if (isJsonRpcNotification(message)) {
			this.handleNotification(message.method, message.params);
			return;
		}
		this.emitError(new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Received invalid JSON-RPC message"));
	}

	private handleResponse(message: JsonRpcResponse): void {
		if (!this.pending.settle(message)) {
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === "notifications/progress") this.pending.progress(params);
		else if (method === "notifications/cancelled") this.incoming.cancel(params);
		for (const listener of this.notificationListeners.get(method) ?? []) {
			try {
				listener(params);
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	/** Tell the server a request was cancelled, when a transport is still attached. */
	private sendCancelled(id: JsonRpcId, reason: string | undefined): void {
		if (!this.transport) return;
		void this.transport
			.send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, ...(reason ? { reason } : {}) },
			})
			.catch((sendError) => this.emitError(sendError));
	}

	private handleTransportClose(): void {
		this.markClosed(new McpConnectionClosedError());
	}

	/** Idempotent: rejects in-flight requests, aborts server requests we are serving, and flips the state. */
	private markClosed(error: Error): void {
		const wasClosed = this.state === "closed";
		this.state = "closed";
		this.pending.rejectAll(error);
		this.incoming.abortAll(error);
		if (wasClosed) return;
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so listeners that unsubscribe during close do not change iteration
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch (listenerError) {
				this.emitError(listenerError);
			}
		}
	}

	private emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	private disposeTransportListeners(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}
