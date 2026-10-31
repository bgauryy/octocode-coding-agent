import os from "node:os";
import type { RemoteAccess, RemoteLink, RemotePublish, RemoteStatus } from "@octocodeai/octocode-contracts/daemon";
import { RelayClient } from "./relay-client.ts";
import { encodeKey, fingerprintOf, newKey } from "./seal.ts";
import type { Loopback } from "./tunnel.ts";

/** The tokens published links carry, by access level; both are replaced when publication stops. The launch token is never here. */
interface Tokens {
	remote: string;
	view: string;
}

/** A published link with the fingerprint of its capability; only the link itself holds the capability. */
interface Published {
	link: RemoteLink;
	fingerprint: string;
}

export interface PublisherOptions {
	port: () => number;
	origin: () => string;
	tokens: () => Tokens;
	/** Replaces the remote control and view tokens: every link issued so far stops working. */
	rotate: () => void;
	build: string;
	activity: () => void;
	/** The SSH host name and user to print in the forward command. */
	host?: () => { user: string; hostname: string };
}

const MAX_LINKS = 50;

/** The relay's page origin for a link: `wss://relay.example/x` is reached by a browser at `https://relay.example/x/`. */
export function relayPageUrl(relayUrl: string): URL {
	const url = new URL(relayUrl);
	url.protocol = url.protocol === "ws:" ? "http:" : "https:";
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	url.search = "";
	url.hash = "";
	return url;
}

/** A relay URL the daemon will dial: `ws:` or `wss:`, nothing in the fragment, no credentials. */
export function validRelayUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password || url.hash)
			return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function defaultHost(): { user: string; hostname: string } {
	let user = "";
	try {
		user = os.userInfo().username;
	} catch {
		// No account name in this environment; the forward prints the host alone.
	}
	return { user, hostname: os.hostname() };
}

/**
 * What `/remote` publishes: links to this daemon for another device, each with its capability in the fragment. `ssh`
 * links are the loopback page itself behind a port forward the user runs; `relay` links are reached through a relay
 * the daemon dials, under a key the relay never sees. One relay room per access level; stopping closes the rooms,
 * forgets every link, and replaces the remote control and view tokens so every stopped link is dead. A control link
 * carries the remote token, never the launch token, which also opens the admin routes.
 */
export class RemotePublisher {
	private readonly options: PublisherOptions;
	private readonly links: Published[] = [];
	private readonly relays = new Map<RemoteAccess, RelayClient>();

	constructor(options: PublisherOptions) {
		this.options = options;
	}

	publish(request: RemotePublish): RemoteLink {
		const existing = this.links.find(
			({ link }) =>
				link.transport === request.transport &&
				link.access === request.access &&
				(request.transport === "ssh" || this.relays.get(request.access)?.url === validRelayUrl(request.relayUrl)),
		);
		if (existing) return existing.link;
		const published = request.transport === "ssh" ? this.sshLink(request.access) : this.relayLink(request);
		this.links.push(published);
		if (this.links.length > MAX_LINKS) this.links.shift();
		return published.link;
	}

	private sshLink(access: RemoteAccess): Published {
		const port = this.options.port();
		const tokens = this.options.tokens();
		const token = access === "view" ? tokens.view : tokens.remote;
		const { user, hostname } = (this.options.host ?? defaultHost)();
		return {
			fingerprint: fingerprintOf(token),
			link: {
				transport: "ssh",
				access,
				url: `http://127.0.0.1:${port}/#access=${token}`,
				issuedAt: Date.now(),
				forward: `ssh -N -L ${port}:127.0.0.1:${port} ${user ? `${user}@` : ""}${hostname}`,
			},
		};
	}

	private relayLink(request: RemotePublish): Published {
		const relayUrl = validRelayUrl(request.relayUrl);
		if (!relayUrl) throw new Error("A relay link needs a ws:// or wss:// relay address (remote.relayUrl).");
		const previous = this.relays.get(request.access);
		if (previous && previous.url !== relayUrl) {
			previous.stop();
			this.relays.delete(request.access);
			this.forget(({ link }) => link.transport === "relay" && link.access === request.access);
		}
		const key = newKey();
		const loopback = (): Loopback => ({
			port: this.options.port(),
			origin: this.options.origin(),
			token: request.access === "view" ? this.options.tokens().view : this.options.tokens().remote,
		});
		const relay = new RelayClient({
			url: relayUrl,
			key,
			access: request.access,
			loopback,
			build: this.options.build,
			activity: this.options.activity,
		});
		this.relays.set(request.access, relay);
		relay.start();
		const page = relayPageUrl(relayUrl);
		page.hash = `k=${encodeKey(key)}`;
		return {
			fingerprint: fingerprintOf(key),
			link: { transport: "relay", access: request.access, url: page.href, issuedAt: Date.now() },
		};
	}

	private forget(matches: (published: Published) => boolean): void {
		for (let index = this.links.length - 1; index >= 0; index--)
			if (matches(this.links[index])) this.links.splice(index, 1);
	}

	status(): RemoteStatus {
		const relay = this.relays.get("control") ?? this.relays.get("view");
		const links = this.links.map(({ link, fingerprint }) => ({
			transport: link.transport,
			access: link.access,
			issuedAt: link.issuedAt,
			fingerprint,
		}));
		return { links, ...(relay ? { relay: relay.status() } : {}) };
	}

	/**
	 * Peers joined through relays right now. The daemon's idle timer counts them as use (`main.ts`), so a phone that is
	 * connected keeps its links alive; a published link nobody has joined does not, and dies with the idle daemon.
	 */
	get peers(): number {
		let total = 0;
		for (const relay of this.relays.values()) total += relay.status().peers;
		return total;
	}

	stop(): void {
		for (const relay of this.relays.values()) relay.stop();
		this.relays.clear();
		this.links.length = 0;
		this.options.rotate();
	}
}
