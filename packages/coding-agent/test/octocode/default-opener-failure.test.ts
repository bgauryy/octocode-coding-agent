import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { createAppWindow, OPEN_BROWSER_ENV } from "../../src/octocode/browser/app-window.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

// The system opener is the external boundary: here it fails the way a missing `xdg-open` does.
const opener = vi.hoisted(() => ({
	openTarget: vi.fn(async (_target: string): Promise<void> => {
		throw new Error("spawn xdg-open ENOENT");
	}),
}));
vi.mock("@octocodeai/octocode-common/open-target", () => opener);

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-default-opener-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	vi.unstubAllEnvs();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("callers of the default system opener when it cannot start", () => {
	it("/backlog html names the written file and the opener's error", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		registerBacklog(fake.api, { commands, isSubagent: false });
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd });
		await commands.get("backlog")!.handler("html", ctx);
		const file = path.join(cwd, ".octocode", "agent", "backlog.html");
		expect(opener.openTarget).toHaveBeenLastCalledWith(file);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: `Wrote ${file} but could not open it: spawn xdg-open ENOENT`,
		});
	});

	it("the app window passes the opener's error to its caller in browser mode and without a Chromium browser", async () => {
		// The run turns browser opening off; this case exercises the real default opener, whose boundary is mocked above.
		vi.stubEnv(OPEN_BROWSER_ENV, "1");
		const browserMode = createAppWindow({ platform: "linux", env: { PATH: "" }, mode: () => "browser" });
		await expect(browserMode.open("http://127.0.0.1:9/")).rejects.toThrow("spawn xdg-open ENOENT");
		const noChromium = createAppWindow({ platform: "linux", env: { PATH: path.join(tmp, "empty") } });
		await expect(noChromium.open("http://127.0.0.1:9/")).rejects.toThrow("spawn xdg-open ENOENT");
		expect(opener.openTarget).toHaveBeenLastCalledWith("http://127.0.0.1:9/");
	});
});
