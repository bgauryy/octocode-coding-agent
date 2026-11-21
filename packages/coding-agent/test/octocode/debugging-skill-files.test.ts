import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";

const skill = path.join(getNativeSkillsDir(), "octocode-debugging");
const has = (command: string) => spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const files = (dir: string): string[] =>
	fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const slugs = (file: string) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => /^#{1,6} /.test(line))
		.map((line) =>
			line
				.replace(/^#+ /, "")
				.toLowerCase()
				.replace(/[^\w\s-]/g, "")
				.replace(/\s+/g, "-"),
		);
const markdown = files(skill).filter((file) => file.endsWith(".md"));

describe("octocode-debugging files", () => {
	it("resolves every relative markdown link, including heading anchors", () => {
		const broken: string[] = [];
		for (const file of markdown) {
			const text = fs.readFileSync(file, "utf8");
			for (const [, target] of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
				const [rel, anchor] = target.split("#");
				const resolved = path.resolve(path.dirname(file), rel);
				if (!fs.existsSync(resolved)) broken.push(`${path.relative(skill, file)} -> ${target}`);
				else if (anchor && !slugs(resolved).includes(anchor))
					broken.push(`${path.relative(skill, file)} -> ${target} (anchor)`);
			}
		}
		expect(broken).toEqual([]);
	});

	it("reaches every reference and script from SKILL.md", () => {
		const entry = fs.readFileSync(path.join(skill, "SKILL.md"), "utf8");
		const reachable = new Set(
			[...entry.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]).filter((target) => !target.startsWith("http")),
		);
		for (const reference of fs.readdirSync(path.join(skill, "references"))) {
			expect(reachable, reference).toContain(`references/${reference}`);
		}
		for (const script of fs.readdirSync(path.join(skill, "scripts"))) expect(entry, script).toContain(script);
	});

	describe("scripts", () => {
		let root: string;
		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-skill-"));
		});
		afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
		const script = (name: string) => path.join(skill, "scripts", name);

		it.each(["node-break.mjs", "profile-top.mjs", "node-metrics.mjs", "metrics-report.mjs"])(
			"%s --help prints usage and exits 0",
			(name) => {
				const result = spawnSync(process.execPath, [script(name), "--help"], { encoding: "utf8" });
				expect(result.status).toBe(0);
				expect(`${result.stdout}${result.stderr}`).toMatch(/Usage/);
			},
		);

		it("native-capture --help exits 0 and bad arguments exit 2 without creating anything", () => {
			expect(spawnSync("bash", [script("native-capture.sh"), "--help"], { encoding: "utf8" }).stdout).toMatch(/Usage/);
			const out = path.join(root, "never");
			expect(spawnSync("bash", [script("native-capture.sh"), "abc", "1", out]).status).toBe(2);
			expect(fs.existsSync(out)).toBe(false);
		});

		it("node-break.mjs pauses only where its condition holds and keeps the program's exit code", () => {
			fs.writeFileSync(
				path.join(root, "t.js"),
				"let s = 0;\nfor (let i = 0; i < 5; i++) {\n\ts += i;\n}\nconsole.log(s);\n",
			);
			const run = spawnSync(
				process.execPath,
				[script("node-break.mjs"), "--break", "t.js:3:i===3", "--eval", "i", "--", "t.js"],
				{ cwd: root, encoding: "utf8", timeout: 30_000 },
			);
			expect(run.status, run.stderr).toBe(0);
			const events = run.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as { event: string; values?: Record<string, unknown>; pauses?: number });
			expect(events.filter((e) => e.event === "hit").map((e) => e.values)).toEqual([{ i: 3 }]);
			expect(events.at(-1)).toMatchObject({ event: "exit", pauses: 1 });
		}, 40_000);

		it("profile-top.mjs ranks the newest CPU profile in a directory", () => {
			const record = spawnSync(
				process.execPath,
				[
					"--cpu-prof",
					"--cpu-prof-dir=prof",
					"-e",
					"function hot(){let x=0;for(let i=0;i<2e7;i++)x+=Math.sqrt(i);return x}hot()",
				],
				{ cwd: root, encoding: "utf8", timeout: 30_000 },
			);
			expect(record.status, record.stderr).toBe(0);
			const top = spawnSync(process.execPath, [script("profile-top.mjs"), "prof", "--top", "5"], {
				cwd: root,
				encoding: "utf8",
			});
			expect(top.status, top.stderr).toBe(0);
			expect(top.stdout).toMatch(/^CPU profile: /m);
			expect(top.stdout).toMatch(/\bhot\b/);
		}, 40_000);

		it.skipIf(!has(process.platform === "darwin" ? "sample" : "perf"))(
			"native-capture records the stacks of a PID and refuses to reuse the directory",
			async () => {
				const child = spawn("sleep", ["10"]);
				try {
					const out = path.join(root, "cap");
					const run = () =>
						spawnSync("bash", [script("native-capture.sh"), String(child.pid), "1", out], { encoding: "utf8" });
					const first = run();
					if (first.status !== 0) expect(first.stderr).toMatch(/permission|attach|Cannot inspect/i);
					else {
						expect(fs.readdirSync(out).sort()).toEqual(["capture.txt", "process.txt", "profiler.log", "stacks.txt"]);
						expect(run().status).not.toBe(0);
					}
				} finally {
					child.kill();
				}
			},
		);

		it("metrics-report charts a node-metrics capture and will not overwrite a report", () => {
			const run = spawnSync(
				process.execPath,
				["--import", script("node-metrics.mjs"), "-e", "const t=Date.now();while(Date.now()-t<250);"],
				{
					cwd: root,
					env: { ...process.env, NODE_OPTIONS: "", OCTOCODE_PROFILE_DIR: root, OCTOCODE_PROFILE_INTERVAL_MS: "50" },
				},
			);
			expect(run.status).toBe(0);
			const capture = fs.readdirSync(root).find((f) => f.endsWith(".metrics.jsonl"));
			expect(capture).toBeDefined();
			const report = path.join(root, "r.html");
			const first = spawnSync(process.execPath, [script("metrics-report.mjs"), path.join(root, capture!), report], {
				encoding: "utf8",
			});
			expect(first.status).toBe(0);
			expect(fs.readFileSync(report, "utf8")).toContain("<polyline");
			expect(
				spawnSync(process.execPath, [script("metrics-report.mjs"), path.join(root, capture!), report]).status,
			).toBe(2);
		});
	});

	describe("debugger command lines in the references", () => {
		let root: string;
		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-cmds-"));
		});
		afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
		const write = (name: string, source: string) => fs.writeFileSync(path.join(root, name), source);

		it.skipIf(!has("python3"))(
			"pdb batch run stops at a conditional breakpoint, prints values and quits on closed stdin",
			() => {
				write("p.py", "def f(xs):\n    t = 0\n    for x in xs:\n        t += x\n    return t\nprint(f([1, 2, 3]))\n");
				const r = spawnSync(
					"python3",
					["-m", "pdb", "-c", "b p.py:4, x > 1", "-c", "c", "-c", "p x, t", "-c", "q", "p.py"],
					{ cwd: root, encoding: "utf8", input: "", timeout: 20_000 },
				);
				expect(r.stdout).toContain("(2, 1)");
			},
		);

		it.skipIf(!has("python3"))(
			"pdb enters post-mortem on an uncaught exception and runs the remaining commands there",
			() => {
				write("e.py", "done = 3\ntotal = 0\ndef go(row):\n    return total / (done - 3)\ngo({'a': 1})\n");
				const r = spawnSync("python3", ["-m", "pdb", "-c", "c", "-c", "p row", "-c", "q", "e.py"], {
					cwd: root,
					encoding: "utf8",
					input: "",
					timeout: 20_000,
				});
				expect(r.stdout).toContain("post mortem");
				expect(r.stdout).toContain("{'a': 1}");
			},
		);

		const cc = has("clang") ? "clang" : has("cc") ? "cc" : "";
		it.skipIf(!has("lldb") || !cc)(
			"lldb batch stops on a condition, a watchpoint and a crash with -k commands",
			() => {
				write(
					"c.c",
					'#include <stdio.h>\n#include <string.h>\nint total = 0;\nint main(int argc, char **argv) {\n  for (int i = 0; i < 3; i++) {\n    total += i;\n  }\n  if (argc > 1) { char *p = 0; strlen(p); }\n  printf("%d\\n", total);\n  return 0;\n}\n',
				);
				expect(spawnSync(cc, ["-g", "-O0", "-o", "c", "c.c"], { cwd: root }).status).toBe(0);
				const lldb = (...args: string[]) =>
					spawnSync("lldb", ["-b", ...args], { cwd: root, encoding: "utf8", timeout: 60_000 }).stdout;
				expect(
					lldb("-o", "breakpoint set -f c.c -l 6 -c 'i == 2'", "-o", "run", "-o", "frame variable", "--", "./c"),
				).toMatch(/\(int\) i = 2/);
				expect(
					lldb(
						"-o",
						"b main",
						"-o",
						"run",
						"-o",
						"watchpoint set variable total",
						"-o",
						"c",
						"-o",
						"p total",
						"--",
						"./c",
					),
				).toMatch(/stop reason = watchpoint 1/);
				expect(
					lldb("-o", "run", "-k", "bt 10", "-k", "frame select 1", "-k", "frame variable", "--", "./c", "x"),
				).toMatch(/\(char \*\) p = 0x0+\b/);
			},
			120_000,
		);

		it.skipIf(!has("go"))(
			"go test -cpuprofile and pprof -top from go.md produce a summary",
			() => {
				write("go.mod", "module x\n\ngo 1.20\n");
				write(
					"w_test.go",
					'package x\nimport "testing"\nfunc BenchmarkWork(b *testing.B) { s := 0; for i := 0; i < b.N; i++ { s += i % 7 }; _ = s }\n',
				);
				const out = path.join(root, "out");
				fs.mkdirSync(out);
				const test = spawnSync(
					"go",
					[
						"test",
						"-run",
						"^$",
						"-bench",
						"^BenchmarkWork$",
						"-benchtime",
						"200ms",
						"-cpuprofile",
						`${out}/cpu.pprof`,
						"-o",
						`${out}/pkg.test`,
						".",
					],
					{ cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, GOFLAGS: "" } },
				);
				expect(test.status, test.stderr).toBe(0);
				const top = spawnSync("go", ["tool", "pprof", "-top", `${out}/pkg.test`, `${out}/cpu.pprof`], {
					cwd: root,
					encoding: "utf8",
					timeout: 60_000,
				});
				expect(top.stdout).toMatch(/flat%/);
			},
			200_000,
		);
	});
});
