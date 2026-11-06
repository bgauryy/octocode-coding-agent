import net from "node:net";

/** Which addresses are public, for the web guard (`web-guard.ts`): the ranges a request may never reach by a redirect, and the cloud metadata addresses it may never reach at all. */

/** Non-public IPv4 ranges: this network, private, CGNAT, loopback, link-local (cloud metadata), Azure's WireServer and IMDS gateway, protocol/test/benchmark, multicast, reserved. */
const V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["168.63.129.16", 32],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
	const values = parts.map(Number);
	if (values.some((value) => value > 255)) return null;
	return ((values[0] << 24) >>> 0) + (values[1] << 16) + (values[2] << 8) + values[3];
}

function inV4(ip: number, base: string, bits: number): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ip & mask) >>> 0 === (ipv4ToInt(base)! & mask) >>> 0;
}

function expandIpv6(ip: string): number[] | null {
	let value = ip.toLowerCase().replace(/%.*$/, "");
	const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	if (dotted) {
		const v4 = ipv4ToInt(dotted[2]);
		if (v4 === null) return null;
		value = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const groups =
		halves.length === 1
			? head
			: [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
	if (groups.length !== 8) return null;
	const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
	return parsed.some(Number.isNaN) ? null : parsed;
}

/**
 * The IPv4 addresses inside an IPv6 address that carries one: mapped (::ffff:a.b.c.d, always, so ::ffff:0.0.0.0 is
 * 0.0.0.0), translated (::ffff:0:a.b.c.d), deprecated compatible (::a.b.c.d, except :: and ::1), NAT64
 * (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32: server, and the bit-inverted client address).
 */
function embeddedIpv4(groups: number[]): string[] {
	const dotted = (left: number, right: number) => `${left >>> 8}.${left & 255}.${right >>> 8}.${right & 255}`;
	const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
	const low = dotted(groups[6], groups[7]);
	if (zero(0, 5) && groups[5] === 0xffff) return [low];
	if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return [low];
	if (zero(0, 6) && (groups[6] !== 0 || groups[7] > 1)) return [low];
	if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return [low];
	if (groups[0] === 0x2002) return [dotted(groups[1], groups[2])];
	if (groups[0] === 0x2001 && groups[1] === 0)
		return [dotted(groups[2], groups[3]), dotted(~groups[6] & 0xffff, ~groups[7] & 0xffff)];
	return [];
}

/** True for any address that is not a public unicast address (anything unparsable counts as blocked). */
export function isBlockedIp(ip: string): boolean {
	const version = net.isIP(ip.replace(/%.*$/, ""));
	if (version === 4) {
		const value = ipv4ToInt(ip)!;
		return V4_BLOCKS.some(([base, bits]) => inV4(value, base, bits));
	}
	if (version !== 6) return true;
	const groups = expandIpv6(ip);
	if (groups === null) return true;
	const embedded = embeddedIpv4(groups);
	if (embedded.length > 0) return embedded.some(isBlockedIp);
	const [first, second] = groups;
	// Only global unicast 2000::/3 is public: loopback, unique local, link-local, multicast, discard and unallocated space
	// all fall outside it, so a range nobody listed here is blocked rather than reachable.
	if ((first & 0xe000) !== 0x2000) return true;
	return (
		(first === 0x2001 && second === 0x0db8) || // documentation 2001:db8::/32
		(first === 0x2001 && (second & 0xfff0) === 0x0010) || // deprecated ORCHID 2001:10::/28
		(first === 0x2001 && (second & 0xfff0) === 0x0020) || // ORCHIDv2 2001:20::/28
		(first === 0x3fff && (second & 0xf000) === 0) // documentation 3fff::/20
	);
}

/** Whether `ip` is link-local (169.254.0.0/16, fe80::/10), also spelled inside an IPv6 address (`::ffff:169.254.1.1`). */
export function isLinkLocalIp(ip: string): boolean {
	const bare = ip.replace(/%.*$/, "");
	const version = net.isIP(bare);
	if (version === 4) return inV4(ipv4ToInt(bare)!, "169.254.0.0", 16);
	if (version !== 6) return false;
	const groups = expandIpv6(bare);
	if (groups === null) return false;
	return (groups[0] & 0xffc0) === 0xfe80 || embeddedIpv4(groups).some(isLinkLocalIp);
}

/** Whether `ip` is loopback (127.0.0.0/8, ::1), also spelled inside an IPv6 address (`::ffff:127.0.0.1`). */
export function isLoopbackIp(ip: string): boolean {
	const bare = ip.replace(/%.*$/, "");
	const version = net.isIP(bare);
	if (version === 4) return inV4(ipv4ToInt(bare)!, "127.0.0.0", 8);
	if (version !== 6) return false;
	const groups = expandIpv6(bare);
	if (groups === null) return false;
	return (
		(groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) || embeddedIpv4(groups).some(isLoopbackIp)
	);
}

/** Cloud instance metadata addresses: a request there returns the machine's credentials to whoever asked. */
const METADATA_ADDRESSES = ["169.254.169.254", "168.63.129.16"];
const METADATA_V6 = expandIpv6("fd00:ec2::254")!;

/** Whether `ip` is a cloud metadata address, also spelled inside an IPv6 address (`::ffff:169.254.169.254`). */
export function isMetadataIp(ip: string): boolean {
	const bare = ip.replace(/%.*$/, "");
	const version = net.isIP(bare);
	if (version === 4) return METADATA_ADDRESSES.includes(bare);
	if (version !== 6) return false;
	const groups = expandIpv6(bare);
	if (groups === null) return false;
	return groups.every((group, at) => group === METADATA_V6[at]) || embeddedIpv4(groups).some(isMetadataIp);
}
