import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockAdvice } from "../../src/octocode/team/lock-advice.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
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
		const fake = fakePi();
		const team = new Team(fake.pi, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		registerCollab(fake.pi, team);
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = async (paths: string[]) =>
			(await fake.tools.get("coordinate").execute("c", { action: "lock", paths }, undefined, undefined, ctx)).content[0]
				.text as string;
		expect(await lock(["packages/a/src/x.ts"])).toBe("Reserved: packages/a/src/x.ts. Unlock when your edits are done.");
		expect(await lock(["packages/b/src/y.ts"])).toContain(
			"You hold paths in 2 packages (packages/a, packages/b): reserve only the files you are editing now",
		);
	});
});
