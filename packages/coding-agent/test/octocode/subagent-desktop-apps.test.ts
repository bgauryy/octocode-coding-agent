import { DESKTOP_APPS_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, describe, expect, it } from "vitest";
import { desktopRefusal } from "../../src/octocode/permission/desktop-mcp.ts";
import { outsideAppsRefusal } from "../../src/octocode/permission/desktop-apps.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { resumeRefusal } from "../../src/octocode/subagents/children.ts";
import { loadProfiles, spawnRequest } from "../../src/octocode/subagents/profiles.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";
import { agentToolSpec } from "../../src/octocode/native/tools/agent/spec.ts";
import { tmp } from "./helpers.ts";

const profiles = () => loadProfiles(tmp(), tmp(), false, {});
const identity = { id: "calc", desktopApps: ["Calculator", "Notes"] };
const permission = { profileSeen: () => true } as never;
const ctx = { cwd: "/tmp" };

describe("a desktop task's apps list", () => {
	afterEach(() => {
		delete process.env[DESKTOP_APPS_ENV];
	});

	it("is a field of the agent tool's task", () => {
		expect(Object.keys(agentToolSpec().parameters.properties)).toContain("apps");
	});

	it("reaches only a desktop child's environment, comma-joined", () => {
		const desktop = profiles().get("desktop");
		expect(subagentProcessEnv(desktop, {}, identity)[DESKTOP_APPS_ENV]).toBe("Calculator,Notes");
		expect(subagentProcessEnv(profiles().get("implementer"), {}, identity)[DESKTOP_APPS_ENV]).toBeUndefined();
		expect(subagentProcessEnv(desktop, {}, { id: "x" })[DESKTOP_APPS_ENV]).toBeUndefined();
	});

	it("is never inherited from the parent's own environment", () => {
		const env = subagentProcessEnv(profiles().get("desktop"), { [DESKTOP_APPS_ENV]: "Terminal" }, { id: "x" });
		expect(env[DESKTOP_APPS_ENV]).toBeUndefined();
	});

	it("is refused for a profile that does not control the desktop", () => {
		const reg = { getAvailable: () => [], getProviderAuthStatus: () => ({ source: "stored" }) } as never;
		const plan = (profile?: string) =>
			planRun(profiles(), { profile, apps: ["Calculator"] }, { modelRegistry: reg } as never);
		expect(() => plan("implementer")).toThrow(/apps requires a profile that controls the desktop/);
		expect(() => plan(undefined)).toThrow(/apps requires/);
	});

	it("names the apps in the spawn dialog, and keeps the old text without them", () => {
		const desktop = profiles().get("desktop");
		const what = (apps?: string[]) =>
			spawnRequest(permission, ctx, desktop, "t", undefined, { apps }).request.what?.[0] ?? "";
		expect(what(["Calculator"])).toMatch(/will control your real desktop \(only: Calculator\)/);
		expect(what(["Calculator", "Notes"])).toMatch(/\(only: Calculator, Notes\)/);
		expect(what()).toMatch(/\(only the apps its task names\)/);
	});

	describe("enforced in the permission layer", () => {
		const call = (tool: string, input: Record<string, unknown>, app?: string) =>
			desktopRefusal(`mcp__desktop__${tool}`, input, undefined, async () => app);

		it("lets an allowed app through and refuses another, naming the list", async () => {
			process.env[DESKTOP_APPS_ENV] = "Calculator";
			expect(await call("launch_app", { name: "calculator.app" })).toBeUndefined();
			expect(await call("launch_app", { bundle_id: "com.apple.Calculator" })).toBeUndefined();
			expect(await call("launch_app", { name: "Safari" })).toMatch(
				/Safari is outside the apps this task may control: calculator/i,
			);
			expect(await call("click", { pid: 7 }, "Calculator.app")).toBeUndefined();
			expect(await call("click", { pid: 7 }, "Maps.app")).toMatch(/Maps.app is outside the apps.*calculator/i);
		});

		it("does not refuse a pid it cannot resolve", async () => {
			process.env[DESKTOP_APPS_ENV] = "Calculator";
			expect(await call("click", { pid: 7 }, undefined)).toBeUndefined();
		});

		it("never lifts the denylist", async () => {
			process.env[DESKTOP_APPS_ENV] = "Terminal";
			expect(await call("launch_app", { name: "Terminal" })).toMatch(/refused in every mode/);
		});

		it("changes nothing when no list is set", async () => {
			expect(await call("launch_app", { name: "Safari" })).toBeUndefined();
			expect(outsideAppsRefusal("Safari", {})).toBeUndefined();
		});
	});
});

describe("a saved desktop task is not resumed without its app list", () => {
	it("refuses a resume of the desktop profile and says what to do instead", () => {
		expect(resumeRefusal("desktop")).toMatch(/name its apps in `apps`.*`message`/);
		expect(resumeRefusal("implementer")).toBeUndefined();
	});
});
