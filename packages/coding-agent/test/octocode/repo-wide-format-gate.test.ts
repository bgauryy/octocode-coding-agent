import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoWideFormat } from "../../src/octocode/team/repo-wide-format.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("repoWideFormat", () => {
	it.each([
		"yarn oxfmt",
		"yarn oxfmt .",
		"yarn run oxfmt --write",
		"oxfmt",
		"npx oxfmt",
		"pnpm exec oxfmt",
		"yarn format",
		"yarn run format",
		"npm run format",
		"git status && yarn oxfmt",
		'yarn oxfmt "$(git ls-files -m)" | tee out; yarn oxfmt',
	])("flags %j", (command) => {
		expect(repoWideFormat(command)).toBe(true);
	});

	it.each([
		"yarn oxfmt packages/ai/src/a.ts",
		"yarn oxfmt a.ts b.ts",
		"yarn oxfmt --check",
		"yarn oxfmt --list-different",
		"yarn run format:check",
		"yarn vitest run",
		"git commit -m 'run yarn oxfmt'",
		"echo oxfmt",
		"yarn oxfmt --write packages/ai/test/x.test.ts",
	])("does not flag %j", (command) => {
		expect(repoWideFormat(command)).toBe(false);
	});
});

describe("the reservation gate for a repo-wide format", () => {
	const stops: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, {});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "ai" }, undefined, undefined, ctx);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		return { lock, gate };
	}

	it("refuses it for an agent holding reservations or facing a peer's, and names `yarn oxfmt <files>`", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		// Nobody holds anything: a repo-wide format is the user's call.
		expect(await owner.gate("yarn oxfmt")).toBeUndefined();

		await owner.lock(["packages/ai/"]);
		for (const who of [owner, peer]) {
			expect(await who.gate("yarn oxfmt")).toMatchObject({
				block: true,
				reason: expect.stringContaining("yarn oxfmt <files>"),
			});
			expect(await who.gate("yarn format")).toMatchObject({ block: true });
			expect(await who.gate("yarn oxfmt packages/ai/src/a.ts")).toBeUndefined();
			expect(await who.gate("yarn oxfmt --check")).toBeUndefined();
		}
	});
});
