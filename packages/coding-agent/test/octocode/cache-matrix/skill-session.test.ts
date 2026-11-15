/**
 * A skill loaded in a real Octocode session (the model reads its SKILL.md; the body arrives as a tool result) leaves the
 * request prefix alone, in the transcript and on each adapter's wire. The stream options the session sent are replayed
 * with it (`requestOptions` of `headless()`).
 */
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { expectAppend } from "../../../../ai/test/cache-matrix/compare.ts";
import { WIRE_CASES } from "../../../../ai/test/cache-matrix/wire.ts";
import { nativeCall } from "../e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "../e2e-headless.ts";
import { approveFixtureSkillFiles } from "../guard-helpers.ts";
import { tmp } from "../helpers.ts";
import { recordings, replayAll } from "./session-wire.ts";

afterEach(disposeSessions);
afterAll(restoreEnv);

const serialized = (context: TranscriptContext, count = context.messages.length) =>
	JSON.stringify(context.messages.slice(0, count));

async function sessionWithSkill() {
	const skills = tmp("skills-");
	const file = path.join(skills, "alpha", "SKILL.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: alpha\ndescription: Alpha skill.\n---\n${"Body of alpha.\n".repeat(200)}`);
	const s = await headless({
		setup: ({ root, cwd, home }) =>
			approveFixtureSkillFiles([{ name: "alpha", filePath: file, category: "global" }], cwd, {
				env: {
					...process.env,
					OCTOCODE_HOME: path.join(home, ".octocode"),
					OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
				},
			}),
		resources: { skillPaths: [skills] },
	});
	return { s, file };
}

describe("a skill loaded in a session", () => {
	it("every later request opens with the earlier ones, the skill body arriving as a tool result", async () => {
		const { s, file } = await sessionWithSkill();
		await s.run("use alpha", [
			() => fauxAssistantMessage([nativeCall("bash", { command: `cat ${file}` })], { stopReason: "toolUse" }),
			say("done"),
		]);
		await s.run("again", [say("ok")]);
		expect(s.contexts).toHaveLength(3);
		for (let index = 1; index < s.contexts.length; index++) {
			const previous = s.contexts[index - 1];
			expect(serialized(s.contexts[index], previous.messages.length)).toBe(serialized(previous));
			expect(s.contexts[index].messages.length).toBeGreaterThan(previous.messages.length);
		}
		// Not vacuous: the skill body reached the model in a tool result.
		expect(serialized(s.contexts[1])).toContain("Body of alpha.");
	});

	it.each(WIRE_CASES.map((entry) => [entry.id, entry] as const))(
		"%s: the session's requests keep the cache prefix on the wire",
		async (_id, entry) => {
			const { s, file } = await sessionWithSkill();
			await s.run("use alpha", [
				() => fauxAssistantMessage([nativeCall("bash", { command: `cat ${file}` })], { stopReason: "toolUse" }),
				say("done"),
			]);
			await s.run("again", [say("ok")]);
			expect(s.requestOptions).toHaveLength(3);
			const wires = await replayAll(recordings(s.contexts, s.requestOptions), entry);
			for (let index = 1; index < wires.length; index++) expectAppend(entry, wires[index - 1], wires[index]);
		},
	);
});
