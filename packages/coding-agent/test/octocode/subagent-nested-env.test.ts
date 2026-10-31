import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CHILD_OWNED_ENV, dropForeignChildEnv } from "../../src/octocode/subagents/process/child-env.ts";
import { subagentProcessEnv } from "../../src/octocode/subagents/process/env.ts";

const resolver = pathToFileURL(fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url))).href;
const setup = fileURLToPath(new URL("../../src/cli/setup.ts", import.meta.url));

/** What a nested Octocode's startup leaves of the child's environment, printed by the real `setupCli`. */
const PROBE = `
const { setupCli } = await import(${JSON.stringify(pathToFileURL(setup).href)});
setupCli();
const keys = ${JSON.stringify([...CHILD_OWNED_ENV, "OCTOCODE_PERMISSION", "OCTOCODE_SESSION_ID"])};
process.stdout.write(JSON.stringify(Object.fromEntries(keys.filter((key) => key in process.env).map((key) => [key, process.env[key]]))));
`;

const childEnv = () =>
	subagentProcessEnv(
		{ name: "worker", description: "", prompt: "role", readOnly: true } as never,
		{ PATH: process.env.PATH, OCTOCODE_SESSION_ID: "s1" },
		{ id: "zesty-kelp", role: "worker", parentId: "main-id", goal: "fix it", parentSession: "s1", scratch: "/tmp/x" },
		undefined,
		"/tmp/role.md",
	);

/** Runs the probe as a child of this process; `viaShell` puts a shell between, as a subagent's `bash` tool does for any program. */
function probe(env: NodeJS.ProcessEnv, viaShell: boolean): Record<string, string> {
	const args = ["--import", resolver, "--input-type=module", "-e", PROBE];
	// The command after the program keeps the shell from replacing itself with it (`sh -c prog` may exec).
	const run = viaShell
		? spawnSync("sh", ["-c", '"$0" "$@"; exit $?', process.execPath, ...args], { env, encoding: "utf8" })
		: spawnSync(process.execPath, args, { env, encoding: "utf8" });
	expect(run.stderr).toBe("");
	return JSON.parse(run.stdout) as Record<string, string>;
}

describe("an Octocode that a subagent's command starts", () => {
	// This test process stands for the Octocode that started the child.
	const env = () => ({ ...childEnv(), OCTOCODE_PARENT_PID: String(process.pid), OCTOCODE_PERMISSION: "manual" });

	it("is a top-level session: the child's identity and run files are cleared, the session variables stay", () => {
		const inherited = env();
		expect(inherited).toMatchObject({ OCTOCODE_SUBAGENT: "1", OCTOCODE_AGENT_ID: "zesty-kelp" });
		expect(probe(inherited, true)).toEqual({ OCTOCODE_PERMISSION: "manual", OCTOCODE_SESSION_ID: "s1" });
	});

	it("keeps the identity when the named Octocode started it directly", () => {
		expect(probe(env(), false)).toMatchObject({
			OCTOCODE_SUBAGENT: "1",
			OCTOCODE_AGENT_ID: "zesty-kelp",
			OCTOCODE_READ_ONLY: "1",
			OCTOCODE_ROLE_PROMPT_FILE: "/tmp/role.md",
		});
	});

	it("decides from the named parent only", () => {
		const env = (parent?: string) => ({
			OCTOCODE_SUBAGENT: "1",
			OCTOCODE_AGENT_ID: "zesty-kelp",
			OCTOCODE_SESSION_ID: "s1",
			...(parent ? { OCTOCODE_PARENT_PID: parent } : {}),
		});
		const alive = () => true;
		// The parent is this process's parent: a real child.
		const direct = env("100 1793000000");
		expect(dropForeignChildEnv(direct, 100, alive)).toBe(false);
		expect(direct.OCTOCODE_AGENT_ID).toBe("zesty-kelp");
		// No parent named: a harness set the markers itself.
		const bare = env();
		expect(dropForeignChildEnv(bare, 7, alive)).toBe(false);
		expect(bare.OCTOCODE_SUBAGENT).toBe("1");
		// The named parent is gone: the child's own parent check ends it, so its identity is left for that.
		const orphan = env("100 1793000000");
		expect(dropForeignChildEnv(orphan, 1, () => false)).toBe(false);
		expect(orphan.OCTOCODE_PARENT_PID).toBe("100 1793000000");
		// A live parent that is not this process's parent: a nested session.
		const nested = env("100 1793000000");
		expect(dropForeignChildEnv(nested, 555, alive)).toBe(true);
		expect(nested).toEqual({ OCTOCODE_SESSION_ID: "s1" });
	});
});
