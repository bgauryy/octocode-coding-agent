import { RequestError } from "@agentclientprotocol/sdk";

/** Opens live output only after identity validation and saved transcript replay. */
export class AcpStartup {
	private identity?: string;
	private readonly ready = Promise.withResolvers<void>();
	readonly output = this.ready.promise;

	private readonly expectedId: string | undefined;
	private readonly prepare: (id: string) => Promise<void>;
	constructor(expectedId: string | undefined, prepare: (id: string) => Promise<void>) {
		this.expectedId = expectedId;
		this.prepare = prepare;
	}

	identify(id: string): void {
		if (this.identity === id) return;
		if (this.identity || (this.expectedId && id !== this.expectedId)) {
			this.close(RequestError.invalidRequest(undefined, "Loaded transcript identity changed."));
			return;
		}
		this.identity = id;
		void this.prepare(id).then(this.ready.resolve, this.ready.reject);
	}

	async validate(id: string): Promise<void> {
		this.identify(id);
		await this.output;
		if (id !== this.identity) throw RequestError.invalidRequest(undefined, "Native session identity changed.");
	}

	close(error: Error = new Error("Session closed during startup.")): void {
		this.ready.reject(error);
	}
}
