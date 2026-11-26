import { beforeAll, describe, expect, it } from "vitest";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";

beforeAll(shellParserReady);

const effect = (command: string) => {
	const { inlineCode, opaque, areas } = shellMutation(command);
	return { inlineCode: inlineCode.length > 0, opaque: opaque.length > 0, areas };
};

describe("inline interpreter scripts", () => {
	it.each([
		"python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF",
		"python3 -c \"open('a.ts','w').write('x')\"",
		"python -c 'print(1)'",
		"perl -e 'unlink q(a.ts)'",
		"perl -pe 's/a/b/' a.ts",
		"node -e \"require('fs').writeFileSync('a.ts','x')\"",
		"node --eval 'x'",
		"node -p '1'",
		"ruby -e 'File.write(%q(a), %q(b))'",
		"echo 'print(1)' | python3",
		"sudo python3 -c 'x'",
		"php -r 'x();'",
	])("reports %j as an unseen write in the cwd", (command) => {
		expect(effect(command)).toEqual({ inlineCode: true, opaque: false, areas: ["."] });
	});

	it("resolves the area against a literal cd", () => {
		expect(effect("cd pkg && python3 - <<'EOF'\nprint(1)\nEOF").areas).toEqual(["./pkg"]);
		expect(effect("cd pkg && python3 -c 'x'").areas).toEqual(["./pkg"]);
	});

	it.each([
		"python3 script.py",
		"python3 -m pytest",
		"python3 --version",
		"node script.js",
		"node --version",
		"perl script.pl",
		"echo python3 -c x",
		"grep -e foo file",
	])("leaves %j alone: no inline code", (command) => {
		const found = shellMutation(command);
		expect([found.opaque, found.inlineCode]).toEqual([[], []]);
	});
});
