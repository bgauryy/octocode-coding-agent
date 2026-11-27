/** Whether the machine is offline, asked after a request failed in a way an outage explains. */

import type * as NodeDns from "node:dns/promises";
import type * as NodeOs from "node:os";

/**
 * `online` or `offline` answers the connectivity check without probing (tests, scripted runs); unset probes. Kept here,
 * not in common's env module, which imports Node built-ins this browser-safe module must not.
 */
const NETWORK_PROBE_ENV = "OCTOCODE_NETWORK_PROBE";

type ProcessWithBuiltins = typeof process & {
	getBuiltinModule?: <T>(id: string) => T | undefined;
};

/** A Node built-in, or nothing outside Node and Bun: a top-level import would break browser builds. */
function builtin<T>(id: string): T | undefined {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return undefined;
	return (process as ProcessWithBuiltins).getBuiltinModule?.<T>(id);
}

/** Hosts of public resolvers: any one resolving proves DNS works, so only the provider's host failed. */
const PROBE_HOSTS = ["one.one.one.one", "dns.google"] as const;
/** A lookup slower than this counts as failed: a connected resolver answers well within it. */
const PROBE_TIMEOUT_MS = 3000;

/** An address that reaches past this machine: not loopback, not link-local (which exists with no network at all). */
function isRoutable(address: { address: string; family: string; internal: boolean }): boolean {
	if (address.internal) return false;
	if (address.family === "IPv6") return !address.address.toLowerCase().startsWith("fe80");
	return !address.address.startsWith("169.254.");
}

/** Whether any interface holds a routable address. */
function hasRoutableInterface(os: typeof NodeOs): boolean {
	return Object.values(os.networkInterfaces()).some((list) => list?.some(isRoutable) ?? false);
}

async function anyProbeResolves(dns: typeof NodeDns): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
		timer.unref?.();
	});
	const resolved = Promise.any(PROBE_HOSTS.map((host) => dns.lookup(host))).then(
		() => true,
		// Every lookup failed: AggregateError is the expected answer, not a fault.
		(error: unknown) => {
			if (error instanceof AggregateError) return false;
			throw error;
		},
	);
	try {
		return await Promise.race([resolved, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether the machine has no network: no routable interface, or none of the probe hosts resolves. `OCTOCODE_NETWORK_PROBE`
 * (`online`, `offline`) answers without probing. Outside Node the network cannot be asked, so the answer is online.
 */
export async function isMachineOffline(): Promise<boolean> {
	const forced = process.env[NETWORK_PROBE_ENV];
	if (forced === "offline") return true;
	if (forced === "online") return false;
	const os = builtin<typeof NodeOs>("node:os");
	const dns = builtin<typeof NodeDns>("node:dns/promises");
	if (!os || !dns) return false;
	if (!hasRoutableInterface(os)) return true;
	return !(await anyProbeResolves(dns));
}
