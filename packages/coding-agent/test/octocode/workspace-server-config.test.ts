import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ServerModule from "../../src/octocode/workspace/server.ts";
import { createSessionConfig } from "../../src/octocode/web-daemon/session-config.ts";
import { workspaceServerFixture } from "./workspace-server-fixture.ts";

// The fixture starts the server as a unit; the root composer injects the settings routes, so do the same here.
vi.mock("../../src/octocode/workspace/server.ts", async (original) => {
	const module = await original<typeof ServerModule>();
	return {
		...module,
		startWorkspaceWeb: (...args: Parameters<typeof module.startWorkspaceWeb>) =>
			module.startWorkspaceWeb(
				args[0],
				args[1],
				args[2],
				args[3],
				args[4],
				createSessionConfig({ name: "repo", root: args[0].repoRoot }),
			),
	};
});

let app: Awaited<ReturnType<typeof workspaceServerFixture>>;
let root: string;
beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-config-"));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", path.join(root, "agent"));
	fs.mkdirSync(path.join(root, "agent"), { recursive: true });
	app = await workspaceServerFixture();
});
afterEach(async () => {
	await app.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("per-session settings routes", () => {
	it("answers the configuration with the page token and refuses without it", async () => {
		const noToken = await app.request(DAEMON_ROUTES.config, undefined, { headers: { authorization: "" } });
		expect(noToken.status).toBe(401);
		const ok = await app.request(DAEMON_ROUTES.config);
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ writable: true });
	});

	it("resolves only this session's repository", async () => {
		expect((await app.request(`${DAEMON_ROUTES.config}?repoId=session`)).status).toBe(200);
		expect((await app.request(`${DAEMON_ROUTES.config}?repoId=other`)).status).toBe(404);
	});

	it("writes a setting into the isolated agent directory with the token only", async () => {
		const command = { key: "defaultProvider", scope: "global", value: "openai" };
		const refused = await app.request(DAEMON_ROUTES.configSettings, command, { headers: { authorization: "" } });
		expect(refused.status).toBe(401);
		const written = await app.request(DAEMON_ROUTES.configSettings, command);
		expect(written.status).toBe(200);
		const file = path.join(root, "agent", "settings.json");
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ defaultProvider: "openai" });
	});

	it("answers a sign-in status request through the session's own manager", async () => {
		const res = await app.request(DAEMON_ROUTES.configSignin, { action: "status", provider: "openai" });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ events: expect.any(Array) });
	});
});
