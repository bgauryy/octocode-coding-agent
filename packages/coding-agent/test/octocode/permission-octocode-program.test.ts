import { beforeAll, describe, expect, it } from "vitest";
import { READ_ONLY_ENV, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { recordShellMutation } from "../../src/octocode/files/bash/mutation.ts";
import { currentMutationRevision } from "../../src/octocode/files/feedback/revisions.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { tmp } from "./helpers.ts";

/**
 * `octocode` in a shell is one program the guards do not model, whatever its subcommand: the product starts a session
 * of its own, and the guards hold no knowledge of what another program by that name does with its arguments.
 */

beforeAll(shellParserReady);

const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
const refusal = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, tmp(), env);

const RUNS = [
	"octocode",
	"octocode --help",
	"octocode --version",
	"octocode some-subcommand '{}' --json",
	"./node_modules/.bin/octocode some-subcommand",
	"echo q | xargs octocode some-subcommand",
];

describe("an `octocode` run in a shell", () => {
	it.each(RUNS)("is refused to a read-only role: %s", (command) => {
		expect(refusal(command)).toContain("`octocode`");
	});

	it.each(RUNS)("is blocked by plan mode: %s", (command) => {
		expect(planReadOnly(command)).toBe(false);
	});

	it("leaves the read-only programs around it judged as before", () => {
		expect(refusal("rg octocode src | head -5")).toBeUndefined();
		expect(planReadOnly("rg octocode src | head -5")).toBe(true);
	});

	it("makes a verification receipt stale, as any program the guard cannot read", async () => {
		const id = "octocode-program";
		const before = currentMutationRevision(id);
		await recordShellMutation("octocode some-subcommand '{}'", tmp(), id);
		expect(currentMutationRevision(id)).not.toBe(before);
	});
});
