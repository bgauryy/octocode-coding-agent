import net from "node:net";
import { describe, expect, it } from "vitest";
import { isBlockedIp, isLinkLocalIp, isLoopbackIp, isMetadataIp, PRIVATE_NETWORK_RANGES } from "../src/ip-address.ts";

describe("isLinkLocalIp", () => {
	it.each(["169.254.169.254", "169.254.0.1", "fe80::1", "febf::1", "fe80::1%en0", "::ffff:169.254.169.254"])(
		"flags %s",
		(ip) => expect(isLinkLocalIp(ip)).toBe(true),
	);
	it.each(["169.253.0.1", "10.0.0.1", "127.0.0.1", "fec0::1", "2001:db8::1", "example.com"])("passes %s", (ip) =>
		expect(isLinkLocalIp(ip)).toBe(false),
	);
});

describe("isLoopbackIp", () => {
	it.each(["127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])("flags %s", (ip) =>
		expect(isLoopbackIp(ip)).toBe(true),
	);
	it.each(["128.0.0.1", "10.0.0.1", "::2", "fe80::1", "localhost"])("passes %s", (ip) =>
		expect(isLoopbackIp(ip)).toBe(false),
	);
});

describe("isMetadataIp", () => {
	it.each([
		"169.254.169.254",
		"168.63.129.16",
		"100.100.100.200",
		"169.254.170.2",
		"192.0.0.192",
		"fd00:ec2::254",
		"FD00:EC2:0:0:0:0:0:254",
		"::ffff:100.100.100.200",
		"::ffff:6464:64c8",
		"::ffff:169.254.170.2",
		"64:ff9b::192.0.0.192",
		"2002:c000:00c0::1",
		"::ffff:192.0.0.192",
		// The sandbox library's list (S9): EKS Pod Identity, AWS's whole IPv6 service block, and each cloud's IPv6 endpoint.
		"169.254.170.23",
		"::ffff:169.254.170.23",
		"fd00:ec2::23",
		"fd00:ec2::255",
		"fd00:ec2:ffff::1",
		"fd20:ce::254",
		"fd00:c1::a9fe:a9fe",
		"fd00:42::42",
		"fd00:a9fe:a9fe::1",
		"fd00:100::100:200",
	])("flags %s", (ip) => expect(isMetadataIp(ip)).toBe(true));
	it.each([
		"100.100.100.201",
		"169.254.170.3",
		"192.0.0.193",
		"192.0.0.191",
		"8.8.8.8",
		// `fd00:ec2::255` was here until the AWS IPv6 service block (fd00:ec2::/32) was listed whole, as the sandbox library lists it.
		"fd00:ec3::254",
		"fd20:ce::255",
		"fd00:42::43",
		"fd00:a9fe:a9fe::2",
		"example.com",
	])("passes %s", (ip) => expect(isMetadataIp(ip)).toBe(false));
});

describe("PRIVATE_NETWORK_RANGES", () => {
	const list = new net.BlockList();
	for (const range of PRIVATE_NETWORK_RANGES) {
		const [base, bits] = range.split("/");
		list.addSubnet(base, Number(bits), net.isIP(base) === 6 ? "ipv6" : "ipv4");
	}
	const listed = (ip: string) => list.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");

	it.each(["10.0.0.5", "172.16.3.4", "192.168.1.1", "100.64.0.1", "198.18.0.1", "fd12::1", "fec0::1"])(
		"lists the private address %s, which isBlockedIp blocks too",
		(ip) => {
			expect(listed(ip)).toBe(true);
			expect(isBlockedIp(ip)).toBe(true);
		},
	);
	it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "8.8.8.8", "2606:4700::1"])(
		"leaves out %s: loopback, link-local, multicast and this-network are refused separately, and public is public",
		(ip) => expect(listed(ip)).toBe(false),
	);
});
