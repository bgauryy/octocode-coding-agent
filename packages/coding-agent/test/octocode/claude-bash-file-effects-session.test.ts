import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

it("scoped source Edit denial stops a Bash redirect before native full or broad Bash allowance", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash(*)"], deny: ["Edit(./original.txt)"] },
	});
	try {
		const target = path.join(f.cwd, "original.txt");
		await f.run("bash", { command: "printf WRITE > original.txt" });
		expect(fs.existsSync(target)).toBe(false);
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Claude permission deny:");
		expect(f.inputs()).toEqual([]);
	} finally {
		await f.close();
	}
});

for (const [name, command] of [
	["append", "printf APPEND >> original.txt"],
	["tee", "printf WRITE | tee original.txt"],
	["command-wrapped tee", "printf WRITE | command tee original.txt"],
	["later command", "printf FIRST > first.txt; printf SECOND > original.txt"],
	["later redirect", "printf WRITE > first.txt > original.txt"],
	["later tee target", "printf WRITE | tee first.txt original.txt"],
	["quoted target", "printf WRITE > 'original.txt'"],
] as const) {
	it(`scoped source Edit denial preflights ${name} before every file effect`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: ["Edit(./original.txt)"] },
		});
		try {
			if (name === "append")
				fs.writeFileSync(path.join(f.cwd, "original.txt"), "BEFORE");
			await f.run("bash", { command });
			expect(fs.existsSync(path.join(f.cwd, "first.txt"))).toBe(false);
			if (name === "append")
				expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
					"BEFORE",
				);
			else expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const bashAllowance of [false, true]) {
	it(`scoped Read-only source policy blocks input redirect ${bashAllowance ? "with" : "without"} a Bash rule`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: {
				allow: bashAllowance ? ["Bash"] : [],
				deny: ["Read(./input.txt)"],
			},
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "input.txt"), "INPUT_SECRET\n");
			await f.run("bash", { command: "cat < input.txt" });
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(JSON.stringify(result)).not.toContain("INPUT_SECRET");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

it("scoped Edit-only source policy initializes shell parsing without any Bash rule", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { deny: ["Edit(./original.txt)"] },
	});
	try {
		await f.run("bash", { command: "printf WRITE > original.txt" });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		expect(
			f.session.messages.findLast((m) => m.role === "toolResult"),
		).toMatchObject({ isError: true });
	} finally {
		await f.close();
	}
});

for (const [name, command, deny, output, fileContent] of [
	[
		"Read restriction on output",
		"printf WRITE > original.txt",
		"Read(./original.txt)",
		undefined,
		"WRITE",
	],
	[
		"Edit restriction on input",
		"cat < input.txt",
		"Edit(./input.txt)",
		"INPUT_SECRET",
		undefined,
	],
	["bare Edit", "printf WRITE > original.txt", "Edit", undefined, "WRITE"],
	[
		"wildcard Edit",
		"printf WRITE > original.txt",
		"Edit(*)",
		undefined,
		"WRITE",
	],
	["bare Read", "cat < input.txt", "Read", "INPUT_SECRET", undefined],
	["wildcard Read", "cat < input.txt", "Read(*)", "INPUT_SECRET", undefined],
	[
		"null device",
		"printf WRITE > /dev/null",
		"Edit(//dev/null)",
		undefined,
		undefined,
	],
	["file descriptor duplication", "printf DUP 1>&2", "Edit", "DUP", undefined],
] as const) {
	it(`shell file policy preserves the ${name} source control`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: [deny] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "input.txt"), "INPUT_SECRET\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: false });
			if (output) expect(JSON.stringify(result)).toContain(output);
			if (fileContent)
				expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
					fileContent,
				);
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const [name, input, exists] of [
	["existing output", false, true],
	["dangling output", false, false],
	["input", true, true],
] as const) {
	it(`shell scoped file denial follows the ${name} symlink target`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: {
				allow: ["Bash"],
				deny: [input ? "Read(./input.txt)" : "Edit(./original.txt)"],
			},
		});
		try {
			const target = path.join(f.cwd, input ? "input.txt" : "original.txt");
			if (exists) fs.writeFileSync(target, "BEFORE");
			fs.symlinkSync(target, path.join(f.cwd, "alias.txt"));
			await f.run("bash", {
				command: input ? "cat < alias.txt" : "printf WRITE > alias.txt",
			});
			if (exists) expect(fs.readFileSync(target, "utf8")).toBe("BEFORE");
			else expect(fs.existsSync(target)).toBe(false);
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const mode of ["manual", "full"] as const) {
	it(`scoped Edit ask does not become a Bash ask in ${mode} mode`, async () => {
		const f = await fixture("claude", {
			mode,
			rules: { allow: ["Bash"], ask: ["Edit(./original.txt)"] },
		});
		try {
			await f.run("bash", { command: "printf WRITE > original.txt" });
			expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
				"WRITE",
			);
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

it("scoped Read ask does not become a Bash ask in full mode", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], ask: ["Read(./input.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "input.txt"), "INPUT_SECRET\n");
		await f.run("bash", { command: "cat < input.txt" });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("INPUT_SECRET");
		expect(f.inputs()).toEqual([]);
	} finally {
		await f.close();
	}
});

it("scoped Edit allowance cannot authorize the original Bash invocation", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Edit(./original.txt)"] },
	});
	try {
		const command = "node -p 42 > original.txt";
		await f.run("bash", { command });
		expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
			"42\n",
		);
		expect(f.inputs()).toHaveLength(1);
		expect(f.inputs()[0]).toMatchObject({
			tool_name: "Bash",
			tool_input: { command },
		});
	} finally {
		await f.close();
	}
});

it("source Bash ask resolves once with the original command for multiple file effects", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], ask: ["Bash"], deny: ["Edit(./unrelated.txt)"] },
	});
	try {
		const command = "printf FIRST > first.txt; printf SECOND > original.txt";
		await f.run("bash", { command });
		expect(fs.readFileSync(path.join(f.cwd, "first.txt"), "utf8")).toBe(
			"FIRST",
		);
		expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
			"SECOND",
		);
		expect(f.inputs()).toHaveLength(1);
		expect(f.inputs()[0]).toMatchObject({
			tool_name: "Bash",
			tool_input: { command },
		});
	} finally {
		await f.close();
	}
});

it("cancelling the original Bash approval prevents every pending shell file effect", async () => {
	const f = await fixture("claude", {
		hold: true,
		mode: "full",
		rules: { ask: ["Bash"], deny: ["Edit(./unrelated.txt)"] },
	});
	try {
		const command = "printf FIRST > first.txt; printf SECOND > original.txt";
		const running = f.run("bash", { command });
		await vi.waitFor(() => expect(f.inputs()).toHaveLength(1));
		expect(f.inputs()[0]).toMatchObject({
			tool_name: "Bash",
			tool_input: { command },
		});
		await f.session.abort();
		await running;
		expect(f.providerRequests).toBe(1);
		expect(fs.existsSync(path.join(f.cwd, "first.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		const pid = Number(fs.readFileSync(path.join(f.root, "hook.pid"), "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		fs.writeFileSync(path.join(f.root, "release"), "");
		await f.close();
	}
});

for (const [name, allow, count] of [
	["broad", ["Bash"], 0],
	["scoped", ["Bash(node *)"], 1],
	["scoped with target", ["Bash(node *)", "Edit(./original.txt)"], 0],
] as const) {
	it(`manual inside redirect preserves ${name} source allowance semantics`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [...allow] },
		});
		try {
			const command = "node -p 42 > original.txt";
			await f.run("bash", { command });
			expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
				"42\n",
			);
			expect(f.inputs()).toHaveLength(count);
			if (count)
				expect(f.inputs()[0]).toMatchObject({
					tool_name: "Bash",
					tool_input: { command },
				});
		} finally {
			await f.close();
		}
	});
}

for (const targetAllowance of [false, true]) {
	it(`protected project redirect asks despite broad Bash${targetAllowance ? " and target" : ""} allowance`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: {
				allow: [
					"Bash",
					...(targetAllowance ? ["Edit(./.claude/generated.txt)"] : []),
				],
			},
		});
		try {
			fs.mkdirSync(path.join(f.cwd, ".claude"), { recursive: true });
			const command = "node -p 42 > .claude/generated.txt";
			await f.run("bash", { command });
			expect(
				fs.readFileSync(path.join(f.cwd, ".claude/generated.txt"), "utf8"),
			).toBe("42\n");
			expect(f.inputs()).toHaveLength(1);
			expect(f.inputs()[0]).toMatchObject({
				tool_name: "Bash",
				tool_input: { command },
			});
		} finally {
			await f.close();
		}
	});
}

it("registered user Bash source denial prevents the actual executor from writing", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], deny: ["Edit(./original.txt)"] },
	});
	try {
		const command = "printf WRITE > original.txt";
		const event = await f.session.extensionRunner!.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext: false,
			cwd: f.cwd,
		});
		const result =
			event?.result ??
			(await f.session.executeBash(command, undefined, {
				excludeFromContext: false,
				operations: event?.operations,
			}));
		expect(result.cancelled).toBe(true);
		expect(result.output).toContain("Claude permission deny:");
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
	} finally {
		await f.close();
	}
});

for (const compatibility of [true, false]) {
	it(`registered user Bash ${compatibility ? "checks protected targets" : "preserves typed consent with source policy off"}`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			compatibility,
			rules: { allow: ["Bash"] },
		});
		try {
			fs.mkdirSync(path.join(f.cwd, ".claude"), { recursive: true });
			const command = "printf WRITE > .claude/generated.txt";
			const event = await f.session.extensionRunner!.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext: false,
				cwd: f.cwd,
			});
			const result =
				event?.result ??
				(await f.session.executeBash(command, undefined, {
					excludeFromContext: false,
					operations: event?.operations,
				}));
			expect(result.cancelled).toBe(false);
			expect(
				fs.readFileSync(path.join(f.cwd, ".claude/generated.txt"), "utf8"),
			).toBe("WRITE");
			expect(f.inputs()).toHaveLength(compatibility ? 1 : 0);
		} finally {
			await f.close();
		}
	});
}

it("registered user Bash retains outside-target approval without a primary native action", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Bash(printf *)"] },
	});
	try {
		const command = "printf WRITE > ../outside.txt";
		const target = path.resolve(f.cwd, "../outside.txt");
		const event = await f.session.extensionRunner!.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext: false,
			cwd: f.cwd,
		});
		const result =
			event?.result ??
			(await f.session.executeBash(command, undefined, {
				excludeFromContext: false,
				operations: event?.operations,
			}));
		expect(result.cancelled).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe("WRITE");
		expect(f.inputs()).toHaveLength(1);
		expect(f.inputs()[0]).toMatchObject({
			tool_name: "Bash",
			tool_input: { command },
		});
	} finally {
		await f.close();
	}
});

for (const broad of [true, false]) {
	it(`dynamic redirect preserves ${broad ? "broad" : "scoped"} source command approval`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [broad ? "Bash(*)" : "Bash(printf *)"] },
		});
		try {
			const command = 'OUT=original.txt; printf WRITE > "$OUT"';
			await f.run("bash", { command });
			expect(fs.readFileSync(path.join(f.cwd, "original.txt"), "utf8")).toBe(
				"WRITE",
			);
			expect(f.inputs()).toHaveLength(broad ? 0 : 1);
		} finally {
			await f.close();
		}
	});
}

it("unknown redirect target with a scoped file denial refuses before effects", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash(*)"], deny: ["Edit(./original.txt)"] },
	});
	try {
		await f.run("bash", { command: 'OUT=original.txt; printf WRITE > "$OUT"' });
		expect(fs.existsSync(path.join(f.cwd, "original.txt"))).toBe(false);
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toMatch(
			/unsupported|cannot|unknown|unresolved/i,
		);
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const access of ["read", "write"] as const) {
	it(`read-write redirect cannot bypass a scoped ${access} denial`, async () => {
		const name = access === "read" ? "input.txt" : "original.txt";
		const f = await fixture("claude", {
			mode: "full",
			rules: {
				allow: ["Bash"],
				deny: [`${access === "read" ? "Read" : "Edit"}(./${name})`],
			},
		});
		try {
			if (access === "read")
				fs.writeFileSync(path.join(f.cwd, name), "INPUT_SECRET");
			await f.run("bash", { command: `cat <> ${name}` });
			if (access === "write")
				expect(fs.existsSync(path.join(f.cwd, name))).toBe(false);
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).not.toContain("INPUT_SECRET");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}
