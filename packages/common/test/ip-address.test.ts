import { describe, expect, it } from "vitest";
import { isLinkLocalIp, isLoopbackIp } from "../src/ip-address.ts";

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
