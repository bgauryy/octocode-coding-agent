import { beforeAll, expect, it } from "vitest";
import {
	bashSyntax,
	initializeBashSyntax,
} from "../../src/octocode/permission/bash-syntax.ts";
beforeAll(initializeBashSyntax);
it("captures raw token boundaries and assignment identity without evaluating them", () => {
	const parsed = bashSyntax('NODE_ENV="a b" timeout 30 printf "SAFE; text"');
	expect(parsed.incomplete).toBe(false);
	expect(parsed.commands[0]).toMatchObject({
		raw: 'NODE_ENV="a b" timeout 30 printf "SAFE; text"',
		assignments: [{ name: "NODE_ENV", raw: 'NODE_ENV="a b"' }],
		tokens: [
			{ raw: "timeout" },
			{ raw: "30" },
			{ raw: "printf" },
			{ raw: '"SAFE; text"' },
		],
		ambiguousRedirect: false,
	});
});
it("retains nested assignment execution and flags interleaved redirect argv", () => {
	const parsed = bashSyntax(
		"A=$(printf BLOCK) timeout 1s > /dev/null printf SAFE",
	);
	expect(parsed.commands).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ raw: "printf BLOCK" }),
			expect.objectContaining({ ambiguousRedirect: true }),
		]),
	);
});
