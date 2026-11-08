import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A failed `bash` result that names a file another agent changed last ends with a line naming that agent. */
describe("build-break attribution", () => {
	const stops: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		registerCollab(fake.api, team);
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		/** The text a `bash` result ends with after every `tool_result` handler ran. */
		const result = async (output: string, extra: Record<string, unknown> = {}) => {
			const event = {
				toolName: "bash",
				toolCallId: "b",
				input: { command: "yarn check" },
				content: [{ type: "text", text: output }],
				details: {},
				isError: true,
				...extra,
			};
			const changed = (await fake.emit("tool_result", event, ctx)).find(
				(item) => item && typeof item === "object" && "content" in item,
			) as { content: Array<{ text: string }> } | undefined;
			return (changed?.content ?? event.content).map((part) => part.text);
		};
		return { team, result };
	}

	async function pair() {
		const cwd = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(cwd, "src"));
		for (const name of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(cwd, "src", name), "x\n");
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		return { cwd, owner, peer };
	}

	it("names the agent that last changed a file the failure points at", async () => {
		const { cwd, owner, peer } = await pair();
		owner.team.editLog()!.record(owner.team.id!, "file", [path.join(cwd, "src", "a.ts")]);
		const lines = await peer.result("src/a.ts:3:1 error TS2304: Cannot find name 'x'.\nsrc/b.ts(4,2): error TS1005");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(new RegExp(`^\\[src/a\\.ts last changed by ${owner.team.id} [^;\\]]+\\]$`));
		expect(lines[1]).not.toContain("b.ts");
	});

	it("stays out of the result when the break is not another agent's recorded change", async () => {
		const { cwd, owner, peer } = await pair();
		const output = "src/a.ts:3:1 error";
		// No recorded change at all.
		expect(await peer.result(output)).toEqual([output]);
		// This session's own change.
		peer.team.editLog()!.record(peer.team.id!, "file", [path.join(cwd, "src", "a.ts")]);
		expect(await peer.result(output)).toEqual([output]);
		// A succeeding command, a nested call, and a path that is no file here.
		owner.team.editLog()!.record(owner.team.id!, "file", [path.join(cwd, "src", "b.ts")]);
		expect(await peer.result("src/b.ts:3:1 error", { isError: false })).toEqual(["src/b.ts:3:1 error"]);
		expect(await peer.result("src/b.ts:3:1 error", { parentToolCallId: "script" })).toEqual(["src/b.ts:3:1 error"]);
		owner.team.editLog()!.record(owner.team.id!, "file", [path.join(cwd, "src", "gone.ts")]);
		expect(await peer.result("src/gone.ts:1:1 error")).toEqual(["src/gone.ts:1:1 error"]);
	});

	it("names every other agent's file in one line, at most five", async () => {
		const { cwd, owner, peer } = await pair();
		const names = Array.from({ length: 7 }, (_, index) => `f${index}.ts`);
		for (const name of names) fs.writeFileSync(path.join(cwd, "src", name), "x\n");
		owner.team.editLog()!.record(
			owner.team.id!,
			"file",
			names.map((name) => path.join(cwd, "src", name)),
		);
		const lines = await peer.result(names.map((name) => `src/${name}:1:1 error`).join("\n"));
		expect(lines).toHaveLength(2);
		expect(lines[1].match(/last changed by/g)).toHaveLength(5);
		expect(lines[1]).not.toContain("\n");
	});
});
