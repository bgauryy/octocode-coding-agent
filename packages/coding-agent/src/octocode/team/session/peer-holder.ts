import { peerDbPath, peerRegistryDir } from "../../shared/home.ts";
import { PeerLeases } from "../peer-leases.ts";

/** The agents-communication package's path leases (read-only), opened on the first guarded write and closed with the session. */
export class PeerHolder {
	private peers: PeerLeases | undefined;
	private readonly host: { self(): string | undefined; warn(text: string): boolean };

	constructor(host: { self(): string | undefined; warn(text: string): boolean }) {
		this.host = host;
	}

	/** The package reads its home from the process environment, so this does too (not the team's injected `env`, which only carries a subagent's identity). */
	get(): PeerLeases {
		this.peers ??= new PeerLeases(peerDbPath(), {
			registry: peerRegistryDir(),
			self: () => this.host.self(),
			warn: (text) => this.host.warn(text),
		});
		return this.peers;
	}

	close(): void {
		this.peers?.close();
		this.peers = undefined;
	}
}
