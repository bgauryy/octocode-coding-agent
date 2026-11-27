import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockAdvice } from "../../src/octocode/team/lock-advice.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A workspace with two packages: `packages/a` and `packages/b`. */
function workspace(): string {
	const root = tmp();
	fs.mkdirSync(path.join(root, ".git"));
	for (const name of ["a", "b"]) {
		fs.mkdirSync(path.join(root, "packages", name, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "packages", name, "package.json"), "{}");
	}
	return root;
}

describe("the coordinate lock advisory", () => {
	const stops: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});

	it("names more than 20 paths or paths in more than one package, and nothing for a narrow lock", () => {
		const root = workspace();
		expect(lockAdvice(root, ["packages/a/src/x.ts", "packages/a/src/y.ts"])).toBe("");
		expect(lockAdvice(root, ["packages/a/src/x.ts", "packages/b/src/"])).toContain(
			"paths in 2 packages (packages/a, packages/b)",
		);
		const many = Array.from({ length: 21 }, (_, at) => `packages/a/src/f${at}.ts`);
		expect(lockAdvice(root, many)).toContain("You hold 21 paths:");
		expect(lockAdvice(root, many.slice(1))).toBe("");
	});

	it("appends the advisory to the lock result", async () => {
		const cwd = workspace();
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		registerCollab(fake.api, team);
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = async (paths: string[]) =>
			(await fake.tools.get("coordinate").execute("c", { action: "lock", paths }, undefined, undefined, ctx)).content[0]
				.text as string;
		expect(await lock(["packages/a/src/x.ts"])).toBe("Reserved 1 path.");
		expect(await lock(["packages/b/src/y.ts"])).toContain(
			"You hold paths in 2 packages (packages/a, packages/b): reserve only the files you are editing now",
		);
	});
});

describe("the reservation gate for PowerShell", () => {
	const stops: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string, readOnly?: (command: string) => boolean) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, readOnly ? { shellReadOnly: readOnly } : {});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		const gate = (toolName: string, input: Record<string, unknown>) =>
			reservationGate({ toolName, input } as never, ctx);
		return { team, lock, gate };
	}

	it("refuses a PowerShell command it cannot show read-only while another agent holds a reservation", async () => {
		const cwd = workspace();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, (command) => command.startsWith("cat "));
		const write = { command: "Set-Content packages/a/src/x.ts 'gone'", type: "powershell" };
		// Nobody holds anything yet: PowerShell runs as before.
		expect(await peer.gate("bash", write)).toBeUndefined();
		await owner.lock(["packages/a/src/x.ts"]);
		const refused = await peer.gate("bash", write);
		expect(refused).toMatchObject({ block: true, reason: expect.stringContaining(`reserved by ${owner.team.id}`) });
		expect(refused?.reason).toContain("PowerShell");
		expect(await peer.gate("powershell", { command: "Remove-Item packages/b/src/y.ts" })).toMatchObject({
			block: true,
		});
		// A command the classifier shows read-only still runs; so does the holder's own PowerShell.
		expect(await peer.gate("bash", { command: "cat packages/a/src/x.ts", type: "powershell" })).toBeUndefined();
		expect(await owner.gate("bash", write)).toBeUndefined();
	});
});

describe("the reservation gate for package scripts", () => {
	it("asks before a package script or opaque runner starts while another agent holds a reservation", async () => {
		const cwd = workspace();
		const db = path.join(tmp(), "team.sqlite");
		const make = async () => {
			const fake = fakeHost();
			const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
			const { reservationGate } = registerCollab(fake.api, team);
			const ctx = fakeCtx({ cwd });
			await fake.emit("session_start", {}, ctx);
			return { fake, team, ctx, reservationGate };
		};
		const owner = await make();
		const peer = await make();
		try {
			await owner.fake.tools
				.get("coordinate")
				.execute("c", { action: "lock", paths: ["packages/a/src/x.ts"], reason: "r" }, undefined, undefined, owner.ctx);
			const run = async (id: string, command: string) => {
				const event = { toolName: "bash", toolCallId: id, input: { command } };
				const verdict = await peer.reservationGate(event as never, peer.ctx);
				const result = {
					toolCallId: id,
					toolName: "bash",
					input: { command },
					content: [{ type: "text", text: "ok" }],
				};
				return { verdict, after: await peer.fake.emit("tool_result", result, peer.ctx) };
			};
			for (const command of [
				"yarn run build",
				"yarn build",
				"yarn generate:schemas",
				"yarn workspace @octocodeai/octocode-agent run generate:prompts",
				"npm run lint",
				"pnpm test",
				"make all",
				"bash scripts/x.sh",
				"./build.sh",
				"cd a && yarn build",
				"NODE_ENV=prod yarn build",
				"env yarn build",
				"time make all",
				"nohup bash x.sh",
				"sudo make install",
				"npx turbo run build",
				'bash -c "yarn build"',
				"sudo -u x make",
				"time -p make",
				"env -i yarn build",
				"bash -e build.sh",
				"sh -x x.sh",
				"yarn",
				"cd a && yarn && echo ok",
			]) {
				const { verdict } = await run("s1", command);
				expect(verdict, command).toMatchObject({ ask: expect.stringContaining("packages/a/src/x.ts") });
				expect((verdict as { block?: boolean }).block).toBeUndefined();
			}
			for (const command of ["echo hi", "yarn --version", "git status", "env", "echo yarnish", "grep -r bash src"]) {
				const { verdict } = await run("s2", command);
				expect(verdict, command).toBeUndefined();
			}
			// The holder's own run is not asked about.
			const ownVerdict = await owner.reservationGate(
				{ toolName: "bash", toolCallId: "o", input: { command: "yarn build" } } as never,
				owner.ctx,
			);
			expect(ownVerdict).toBeUndefined();
		} finally {
			await owner.fake.emit("session_shutdown", {}, owner.ctx);
			await peer.fake.emit("session_shutdown", {}, peer.ctx);
		}
	});
});
