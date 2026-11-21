import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	compareVersions,
	type DriverRunner,
	driverVersion,
	healthWarnings,
	MIN_DRIVER_VERSION,
	versionNotice,
} from "../src/presets/desktop/health.ts";

const answering =
	(replies: Record<string, { stdout: string; status: number | null } | undefined>): DriverRunner =>
	(_command, args) =>
		replies[args.join(" ")];

describe("the desktop preset's version floor", () => {
	it("is the version the recorded tool list was taken from", () => {
		const recorded = JSON.parse(readFileSync(new URL("./fixtures/desktop/tools.json", import.meta.url), "utf8")) as {
			driverVersion: string;
		};
		expect(MIN_DRIVER_VERSION).toBe(recorded.driverVersion);
	});

	it("compares versions numerically, not as text", () => {
		expect(compareVersions("0.9.0", "0.30.4")).toBeLessThan(0);
		expect(compareVersions("0.56.4", "0.30.4")).toBeGreaterThan(0);
		expect(compareVersions("0.30.4", "0.30.4")).toBe(0);
		expect(compareVersions("garbage", "0.30.4")).toBe(0);
	});

	it("warns for an older Driver, and says nothing for the floor, a newer one or an unknown version", () => {
		expect(versionNotice("0.29.9")).toMatch(/older than 0\.30\.4/);
		expect(versionNotice("0.30.4")).toBeUndefined();
		expect(versionNotice("0.56.4")).toBeUndefined();
		expect(versionNotice(undefined)).toBeUndefined();
	});

	it("reads the version from `--version` output, and nothing from a command that fails", () => {
		expect(driverVersion("x", answering({ "--version": { stdout: "cua-driver 0.56.4\n", status: 0 } }))).toBe("0.56.4");
		expect(driverVersion("x", answering({ "--version": { stdout: "boom", status: 1 } }))).toBeUndefined();
		expect(driverVersion("x", answering({}))).toBeUndefined();
	});
});

describe("the desktop preset's health probe", () => {
	const permissions = (accessibility: unknown, screen_recording: unknown) =>
		answering({
			"permissions status --json": { stdout: JSON.stringify({ accessibility, screen_recording }), status: 0 },
		});

	it("names a missing Accessibility or Screen Recording grant and the command that fixes it", () => {
		const [both] = healthWarnings("x", "darwin", permissions(false, false));
		expect(both).toContain("Accessibility or Screen Recording");
		expect(both).toContain("cua-driver permissions grant");
		expect(healthWarnings("x", "darwin", permissions(true, false))[0]).toContain("no Screen Recording");
	});

	it("says nothing when the grants are present, unknown (no daemon yet) or unreadable, and on other platforms", () => {
		expect(healthWarnings("x", "darwin", permissions(true, true))).toEqual([]);
		expect(healthWarnings("x", "darwin", permissions("unknown", "unknown"))).toEqual([]);
		expect(
			healthWarnings("x", "darwin", answering({ "permissions status --json": { stdout: "not json", status: 0 } })),
		).toEqual([]);
		expect(
			healthWarnings("x", "darwin", answering({ "permissions status --json": { stdout: "", status: 2 } })),
		).toEqual([]);
		expect(healthWarnings("x", "darwin", answering({}))).toEqual([]);
		expect(healthWarnings("x", "linux", permissions(false, false))).toEqual([]);
	});
});
