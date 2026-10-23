import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

const literalCases = [
	[
		"quoted semicolon",
		"printf '%s' 'SAFE; printf BLOCK' > $MARKER",
		"SAFE; printf BLOCK",
	],
	[
		"quoted and",
		"printf '%s' 'SAFE && printf BLOCK' > $MARKER",
		"SAFE && printf BLOCK",
	],
	[
		"quoted pipe",
		"printf '%s' 'SAFE | printf BLOCK' > $MARKER",
		"SAFE | printf BLOCK",
	],
	["escaped raw word", String.raw`printf BL\OCK > $MARKER`, "BLOCK"],
] as const;

for (const [name, command, expected] of literalCases) {
	it(`source Bash grammar allows ${name} that does not match the raw deny rule`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { deny: ["Bash(printf BLOCK*)"] },
		});
		try {
			await f.run("bash", {
				command: command.replaceAll("$MARKER", JSON.stringify(f.marker)),
			});
			expect(fs.readFileSync(f.marker, "utf8")).toBe(expected);
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: false });
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

const deniedCases = [
	["semicolon chain", "printf ORIGINAL > $MARKER; printf BLOCK"],
	["and chain", "printf ORIGINAL > $MARKER && printf BLOCK"],
	["pipeline", "printf ORIGINAL | printf BLOCK > $MARKER"],
	["subshell", "(printf BLOCK) > $MARKER"],
	["command substitution", 'printf "%s" "$(printf BLOCK)" > $MARKER'],
	["redirection", "printf BLOCK > $MARKER"],
	["or chain", "printf ORIGINAL > $MARKER || printf BLOCK"],
	["newline", "printf ORIGINAL > $MARKER\nprintf BLOCK"],
	["background", "printf BLOCK & printf ORIGINAL > $MARKER"],
	["stderr pipeline", "printf ORIGINAL |& printf BLOCK > $MARKER"],
	["backticks", 'printf "%s" "`printf BLOCK`" > $MARKER'],
	["process substitution", "cat <(printf BLOCK) > $MARKER"],
] as const;

for (const [name, command] of deniedCases) {
	it(`source Bash grammar matches ${name} as a source denial before any effect`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { deny: ["Bash(printf BLOCK*)"] },
		});
		try {
			await f.run("bash", {
				command: command.replaceAll("$MARKER", JSON.stringify(f.marker)),
			});
			expect(fs.existsSync(f.marker)).toBe(false);
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(JSON.stringify(result)).not.toContain("Unsupported applicable");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const [name, command, expected] of [
	["chain", "printf ORIGINAL > $MARKER; printf BLOCK", "ORIGINAL"],
	["subshell", "(printf BLOCK) > $MARKER", "BLOCK"],
	["substitution", 'printf "%s" "$(printf BLOCK)" > $MARKER', "BLOCK"],
] as const) {
	it(`unrestricted native Bash still executes ${name}`, async () => {
		const f = await fixture("claude", { mode: "full" });
		try {
			await f.run("bash", {
				command: command.replaceAll("$MARKER", JSON.stringify(f.marker)),
			});
			expect(fs.readFileSync(f.marker, "utf8")).toBe(expected);
		} finally {
			await f.close();
		}
	});
}

for (const operator of [";", "||"] as const) {
	it(`source Bash ask checks the second ${operator} branch before native full and resolves once`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { ask: ["Bash(printf BLOCK*)"] },
		});
		try {
			await f.run("bash", {
				command: `printf ORIGINAL > ${JSON.stringify(f.marker)} ${operator} printf BLOCK`,
			});
			expect(fs.readFileSync(f.marker, "utf8")).toBe("ORIGINAL");
			expect(f.inputs()).toHaveLength(1);
			expect(f.inputs()[0]).toMatchObject({ tool_name: "Bash" });
		} finally {
			await f.close();
		}
	});
}

for (const [name, allow, expectedHooks] of [
	["no rule", [], 1],
	["only first leaf", ["Bash(node -p 41)"], 1],
	["both leaves", ["Bash(node -p 41)", "Bash(node -p 42)"], 0],
	["whole raw command", ["Bash(node -p 41; node -p 42)"], 0],
] as const) {
	it(`source Bash allowance with ${name} preserves compound approval requirements`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [...allow] },
		});
		try {
			await f.run("bash", { command: "node -p 41; node -p 42" });
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("41");
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(expectedHooks);
		} finally {
			await f.close();
		}
	});
}

for (const [name, rules, denied] of [
	["whole raw deny", { deny: ["Bash(node -p 41; node -p 42)"] }, true],
	[
		"whole allow with second leaf deny",
		{ allow: ["Bash(node -p 41; node -p 42)"], deny: ["Bash(node -p 42)"] },
		true,
	],
	[
		"whole raw ask in full mode",
		{ ask: ["Bash(node -p 41; node -p 42)"] },
		false,
	],
] as const) {
	it(`source Bash ${name} matches the observed rule precedence`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: JSON.parse(JSON.stringify(rules)),
		});
		try {
			await f.run("bash", { command: "node -p 41; node -p 42" });
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: denied });
			if (denied)
				expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const [name, command, rule, expected] of [
	["middle", "printf > $MARKER BLOCK", "Bash(printf BLOCK*)", "BLOCK"],
	["leading", "> $MARKER printf BLOCK", "Bash(printf BLOCK*)", "BLOCK"],
	["split arguments", "printf A > $MARKER BLOCK", "Bash(printf A BLOCK*)", "A"],
] as const) {
	it(`source Bash preserves raw matching with ${name} redirection`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { deny: [rule] },
		});
		try {
			await f.run("bash", {
				command: command.replaceAll("$MARKER", JSON.stringify(f.marker)),
			});
			expect(fs.readFileSync(f.marker, "utf8")).toBe(expected);
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: false });
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const [name, allow, expectedHooks] of [
	["no allowance", [], 1],
	["truncated allowance", ["Bash(node -p)"], 1],
	["complete raw allowance", ["Bash(node -p >/dev/null 42)"], 0],
] as const) {
	it(`source Bash interleaved redirect retains its suffix with ${name}`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [...allow] },
		});
		try {
			await f.run("bash", { command: "node -p >/dev/null 42" });
			expect(
				f.session.messages.findLast((m) => m.role === "toolResult"),
			).toMatchObject({ isError: false });
			expect(f.inputs()).toHaveLength(expectedHooks);
		} finally {
			await f.close();
		}
	});
}

for (const [shape, command] of [
	["file redirect", "node -p 42 > $MARKER"],
	["conditional", "if true; then node -p 42; fi"],
] as const) {
	for (const [name, allow, expectedHooks] of [
		["no allowance", [], 1],
		["bare Bash", ["Bash"], 0],
		["Bash wildcard", ["Bash(*)"], 0],
	] as const) {
		it(`source ${name} keeps broad grant semantics for ${shape}`, async () => {
			const f = await fixture("claude", {
				mode: "manual",
				rules: { allow: [...allow] },
			});
			try {
				await f.run("bash", {
					command: command.replaceAll("$MARKER", JSON.stringify(f.marker)),
				});
				const result = f.session.messages.findLast(
					(m) => m.role === "toolResult",
				);
				expect(result).toMatchObject({ isError: false });
				if (shape === "file redirect")
					expect(fs.readFileSync(f.marker, "utf8")).toBe("42\n");
				else expect(JSON.stringify(result)).toContain("42");
				expect(f.inputs()).toHaveLength(expectedHooks);
			} finally {
				await f.close();
			}
		});
	}
}

it("scoped nested source deny beats a broad Bash wildcard grant before effects", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Bash(*)"], deny: ["Bash(node -p 42*)"] },
	});
	try {
		await f.run("bash", {
			command: `if true; then node -p 42 > ${JSON.stringify(f.marker)}; fi`,
		});
		expect(fs.existsSync(f.marker)).toBe(false);
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Claude permission deny:");
		expect(f.inputs()).toEqual([]);
	} finally {
		await f.close();
	}
});

for (const [pattern, denied] of [
	["blocked", true],
	["other", false],
] as const) {
	it(`source Bash raw URL colon ${denied ? "matches" : "does not match"} the command rule`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { deny: [`Bash(printf http://${pattern}*)`] },
		});
		try {
			await f.run("bash", {
				command: `printf http://blocked > ${JSON.stringify(f.marker)}`,
			});
			const result = f.session.messages.findLast(
				(m) => m.role === "toolResult",
			);
			expect(result).toMatchObject({ isError: denied });
			if (denied) {
				expect(fs.existsSync(f.marker)).toBe(false);
				expect(JSON.stringify(result)).toContain("Claude permission deny:");
			} else expect(fs.readFileSync(f.marker, "utf8")).toBe("http://blocked");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}
