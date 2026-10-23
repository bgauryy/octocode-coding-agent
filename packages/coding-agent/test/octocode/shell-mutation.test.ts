import { beforeAll, describe, expect, it } from "vitest";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";

beforeAll(shellParserReady);

describe("shellMutation", () => {
	it("names the paths a command writes, moves or removes", () => {
		const writes = (command: string) => shellMutation(command).writes;
		expect(writes("echo x > src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("echo x >> src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("cat a | tee -a out.txt")).toEqual(["out.txt"]);
		expect(writes("rm -rf src/a.ts lib")).toEqual(["src/a.ts", "lib"]);
		expect(writes("mv src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(writes("cp src/a.ts dist/a.ts")).toEqual(["dist/a.ts"]);
		expect(writes("cp -t dist src/a.ts")).toEqual(["dist"]);
		expect(writes("sed -i s/a/b/ src/a.ts")).toContain("src/a.ts");
		expect(writes("timeout 5 touch src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("sh -c 'echo x > src/a.ts'")).toEqual(["src/a.ts"]);
		expect(writes("cd pkg && echo x > a.ts")).toEqual([]);
	});

	it("reports changes without a path, and writes it cannot resolve", () => {
		expect(shellMutation("git commit -am x").opaque).toEqual(["git commit"]);
		expect(shellMutation("yarn install").opaque).toEqual(["yarn install"]);
		expect(shellMutation("sed -i s/a/b/ a.ts").opaque).toEqual(["sed -i"]);
		expect(shellMutation("echo x > $FILE").uncertain).toBe(true);
		expect(shellMutation("git status")).toEqual({ writes: [], opaque: [], uncertain: false });
	});

	it("sees nothing in reads, redirects to /dev/null and test runs", () => {
		for (const command of [
			"ls src | wc -l",
			"rg foo src 2>/dev/null",
			"git log --oneline -5",
			"yarn test",
			"git stash list",
		])
			expect(shellMutation(command), command).toEqual({ writes: [], opaque: [], uncertain: false });
	});
});
