import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { environmentWantsStillMotion } from "../src/core/settings-manager/motion-environment.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("environmentWantsStillMotion", () => {
	it("moves on an interactive terminal outside CI", () => {
		expect(environmentWantsStillMotion({}, true)).toBe(false);
		expect(environmentWantsStillMotion({ CI: "", REDUCE_MOTION: "0", NO_MOTION: "false" }, true)).toBe(false);
		expect(environmentWantsStillMotion({ CI: "false" }, true)).toBe(false);
	});

	it.each(["OCTOCODE_REDUCE_MOTION", "REDUCE_MOTION", "NO_MOTION"])("stills for %s=1 or true", (name) => {
		expect(environmentWantsStillMotion({ [name]: "1" }, true)).toBe(true);
		expect(environmentWantsStillMotion({ [name]: " TRUE " }, true)).toBe(true);
	});

	it("stills when stdout is not a terminal or CI is set", () => {
		expect(environmentWantsStillMotion({}, false)).toBe(true);
		expect(environmentWantsStillMotion({}, undefined)).toBe(true);
		expect(environmentWantsStillMotion({ CI: "true" }, true)).toBe(true);
		expect(environmentWantsStillMotion({ CI: "1" }, true)).toBe(true);
	});
});

describe("auto reduced motion in a settings manager", () => {
	const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const saved = { ...process.env };
	beforeEach(() => {
		for (const name of ["CI", "OCTOCODE_REDUCE_MOTION", "REDUCE_MOTION", "NO_MOTION"]) delete process.env[name];
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	});
	afterEach(() => {
		process.env = { ...saved };
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else delete (process.stdout as { isTTY?: boolean }).isTTY;
	});

	it("follows the environment, and an explicit choice still wins", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.isReduceMotionActive()).toBe(false);
		process.env.NO_MOTION = "1";
		expect(manager.isReduceMotionActive()).toBe(true);
		delete process.env.NO_MOTION;
		process.env.CI = "true";
		expect(manager.isReduceMotionActive()).toBe(true);
		manager.setReduceMotion(false);
		expect(manager.isReduceMotionActive()).toBe(false);
	});
});
