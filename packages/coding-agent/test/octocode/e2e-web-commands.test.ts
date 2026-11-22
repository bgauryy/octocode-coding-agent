import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { TERMINAL_COMMAND_ROUTE, type TerminalCommandResult } from "@octocodeai/octocode-contracts/protocol";
import { menuCommands } from "../../src/modes/interactive/interactive-mode/command-menu.ts";
import { findWebDaemon, daemonRequest } from "../../src/octocode/web-daemon/launcher.ts";
import { startInteractive, type InteractiveHarness } from "./e2e-commands-harness.ts";
vi.mock("@octocodeai/octocode-common/open-target", () => ({
	openTarget: async () => undefined,
}));
// `/web` opens an app window by default: it is the external boundary, so no run can start a real browser.
vi.mock("../../src/octocode/browser/app-window.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createAppWindow: () => ({
		open: async () => undefined,
		close: async () => undefined,
	}),
}));

let t: InteractiveHarness;
beforeAll(async () => {
	t = await startInteractive();
}, 120000);
afterAll(async () => t?.stop());

it("serves the live slash menu and drives the attached session's configuration dialog through the local web daemon", async () => {
	await t.submit("/web");
	const daemon = await findWebDaemon();
	if (!daemon) throw new Error("Expected a local web daemon");
	const sessionId = t.host.session.sessionId;
	const route = `/s/${sessionId}${TERMINAL_COMMAND_ROUTE}`;
	const catalog = await daemonRequest(daemon, route);
	expect(catalog?.status).toBe(200);
	const list = catalog?.json() as Extract<TerminalCommandResult, { commands: unknown }>;
	expect(list.sessionId).toBe(sessionId);
	expect(list.commands.map((c) => c.name)).toEqual(menuCommands(t.host.getSlashCommands(true)).map((c) => c.name));
	const id = "web-configuration";
	const post = (body: object) => daemonRequest(daemon, route, { method: "POST", body: { id, sessionId, ...body } });
	expect((await post({ action: "run", name: "unregistered-command", args: "" }))?.status).toBe(409);
	expect((await post({ action: "run", name: "settings", args: "" }))?.status).toBe(200);
	const status = async () =>
		(await post({ action: "status" }))?.json() as Exclude<TerminalCommandResult, { commands: unknown }>;
	await t.until(async () => (await status()).phase === "dialog", "web configuration dialog");
	const open = await status();
	expect(open.text).toMatch(/Configuration[\s\S]*Interface and session/);
	expect((await post({ action: "input", dialog: "stale", sequence: 1, key: "escape" }))?.status).toBe(409);
	const close = { action: "input", dialog: open.dialog, sequence: 1, key: "escape" };
	expect((await post(close))?.json()).toMatchObject({ phase: "done", sequence: 1 });
	expect((await post(close))?.json()).toMatchObject({ phase: "done", sequence: 1 });
	expect((await post({ action: "run", name: "rename", args: "duplicate" }))?.status).toBe(409);
	expect((await post({ action: "run", id: "rename-web", name: "rename", args: "from the browser" }))?.status).toBe(200);
	await t.until(() => t.host.sessionManager.getSessionName() === "from the browser", "session renamed through web");
	const pad = t.host.outputPad === 1 ? 0 : 1;
	expect(
		(await post({ action: "run", id: "change-setting", name: "config", args: `set outputPad ${pad}` }))?.status,
	).toBe(200);
	await t.until(
		() => t.host.outputPad === pad && t.host.settingsManager.getOutputPad() === pad,
		"web setting applied to the live terminal",
	);
	const result = (await post({ action: "status", id: "change-setting" }))?.json();
	expect(result).toMatchObject({ phase: "done", text: expect.stringContaining("outputPad") });
});
