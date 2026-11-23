import net from "node:net";
import { PRIVATE_NETWORK_RANGES } from "@octocodeai/octocode-common/ip-address";

/** `PRIVATE_NETWORK_RANGES` as a set to test addresses against. */
const PRIVATE = new net.BlockList();
for (const range of PRIVATE_NETWORK_RANGES) {
	const [base = "", bits = ""] = range.split("/");
	PRIVATE.addSubnet(base, Number(bits), net.isIP(base) === 6 ? "ipv6" : "ipv4");
}

/** The ranges the sandbox's proxy refuses a hostname to resolve into unless pinned: `PRIVATE_NETWORK_RANGES`. */
export const DENIED_RESOLVED_ADDRESSES = [...PRIVATE_NETWORK_RANGES];

const isPrivate = (address: string): boolean => {
	const family = net.isIP(address);
	return family !== 0 && PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4");
};

/** `address` at `port` as an allow-list entry the library reads as an IP literal: `10.0.0.5:8080`, `[fd00::1]:443`, or the bare address for any port. */
function literalEntry(address: string, port: number | undefined): string {
	if (port === undefined) return address;
	return net.isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * The private addresses hostnames may reach through the sandbox's proxy. The proxy refuses a hostname that resolves into
 * `DENIED_RESOLVED_ADDRESSES` when it connects, so a host answered as public cannot be pointed at the private network
 * afterwards (DNS rebinding). A host answered as private (`net.private` allowed) may reach the private addresses it
 * resolved to then: the library lets a name resolve to a denied address only when that address, with its port, is an IP
 * literal on its allow list, which also lets a command reach that address and port directly. A pin lasts as its answer
 * does: for the session, or while the commands running when it was given run.
 */
export class PrivatePins {
	private readonly session = new Set<string>();
	/** Pins given once, by entry, with the commands that hold them. */
	private readonly running = new Map<string, Set<string>>();

	/** Pins the private ones of `addresses` at `port`, for the session or for `holders`; true when the list changed. */
	add(addresses: readonly string[], port: number | undefined, holders: "session" | readonly string[]): boolean {
		const before = this.entries().length;
		for (const address of addresses) {
			if (!isPrivate(address)) continue;
			const entry = literalEntry(address, port);
			if (holders === "session") this.session.add(entry);
			else if (holders.length > 0) {
				const held = this.running.get(entry) ?? new Set<string>();
				for (const id of holders) held.add(id);
				this.running.set(entry, held);
			}
		}
		return this.entries().length !== before;
	}

	/** The command `id` ended: the pins only it held go; true when the list changed. */
	release(id: string): boolean {
		const before = this.entries().length;
		for (const [entry, held] of this.running) if (held.delete(id) && held.size === 0) this.running.delete(entry);
		return this.entries().length !== before;
	}

	/** A new session's answers start: the last session's pins go; true when the list changed. */
	clearSession(): boolean {
		const before = this.entries().length;
		this.session.clear();
		return this.entries().length !== before;
	}

	/** Every pin, for the library's allow list. */
	entries(): string[] {
		return [...new Set([...this.session, ...this.running.keys()])];
	}
}
