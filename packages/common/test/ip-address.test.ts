import { describe, expect, it } from "vitest";
import { isLinkLocalIp, isLoopbackIp, isMetadataIp } from "../src/ip-address.ts";

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
	])("flags %s", (ip) => expect(isMetadataIp(ip)).toBe(true));
	it.each([
		"100.100.100.201",
		"169.254.170.3",
		"192.0.0.193",
		"192.0.0.191",
		"8.8.8.8",
		"fd00:ec2::255",
		"example.com",
	])("passes %s", (ip) => expect(isMetadataIp(ip)).toBe(false));
});
