import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

for (const command of [
	"time node -p 42",
	"nice node -p 42",
	"nice -n 3 node -p 42",
	"nohup node -p 42",
	"command node -p 42",
]) {
	it(`source inner allowance executes ${command} without another approval`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: ["Bash(node -p 42)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

it("command -v remains a lookup and cannot inherit the queried executable allowance", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Bash(node -p 42)"] },
	});
	try {
		await f.run("bash", { command: "command -v node" });
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({ isError: false });
		expect(f.inputs()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

for (const [name, command, hooks] of [
	["nested wrappers", "nice nohup node -p 42", 0],
	["known safe assignment", "NODE_ENV=test node -p 42", 0],
	["unknown assignment", "FOO=bar node -p 42", 1],
	["env executable", "env NODE_ENV=test node -p 42", 1],
	["spaced stdbuf option", "stdbuf -o L node -p 42", 1],
] as const) {
	it(`source inner allowance preserves ${name} approval semantics`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: ["Bash(node -p 42)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(hooks);
		} finally {
			await f.close();
		}
	});
}

for (const behavior of ["deny", "ask"] as const) {
	for (const [name, command, rule, output] of [
		["known assignment", "NODE_ENV=test node -p 42", "Bash(node -p 42)", "42"],
		["unknown assignment", "FOO=bar node -p 42", "Bash(node -p 42)", "42"],
		["builtin", "builtin printf BLOCK", "Bash(printf BLOCK)", "BLOCK"],
	] as const) {
		it(`source ${behavior} traverses ${name} before native full`, async () => {
			const f = await fixture("claude", {
				mode: "full",
				rules: { [behavior]: [rule] },
			});
			try {
				await f.run("bash", { command });
				const result = f.session.messages.findLast((m) => m.role === "toolResult");
				expect(result).toMatchObject({ isError: behavior === "deny" });
				if (behavior === "deny") expect(JSON.stringify(result)).toContain("Claude permission deny:");
				else expect(JSON.stringify(result)).toContain(output);
				expect(f.inputs()).toHaveLength(behavior === "deny" ? 0 : 1);
			} finally {
				await f.close();
			}
		});
	}
}

for (const exact of [false, true]) {
	it(`${exact ? "exact" : "prefix"} find exec allowance preserves source approval requirements`, async () => {
		const command = String.raw`find . -prune -exec node -p 42 \;`;
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [exact ? `Bash(${command})` : "Bash(find *)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(exact ? 0 : 1);
		} finally {
			await f.close();
		}
	});
}

for (const [name, command, hooks] of [
	["joined nice option", "nice -n3 node -p 42", 1],
	["time option", "time -p node -p 42", 1],
	["joined stdbuf option", "stdbuf -oL node -p 42", 0],
	["quoted wrapper target", 'nice "node" -p 42', 0],
	["escaped wrapper target", String.raw`nice n\ode -p 42`, 0],
] as const) {
	it(`source inner allowance distinguishes ${name}`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: ["Bash(node -p 42)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(hooks);
		} finally {
			await f.close();
		}
	});
}

for (const [name, suffix, allow, hooks] of [
	["bare xargs with inner prefix", "xargs node -p", ["Bash(printf *)", "Bash(node -p*)"], 0],
	["flagged xargs", "xargs -n1 node -p", ["Bash(printf *)", "Bash(node -p*)"], 1],
	["xargs double dash", "xargs -- node -p", ["Bash(printf *)", "Bash(node -p*)"], 1],
	["xargs prefix rule", "xargs node -p", ["Bash(printf *)", "Bash(xargs *)"], 0],
	["exact xargs pipeline rule", "xargs node -p", [String.raw`Bash(printf '42\n' | xargs node -p)`], 1],
] as const) {
	it(`${name} keeps source approval semantics with actual stdin execution`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [...allow] },
		});
		try {
			await f.run("bash", { command: String.raw`printf '42\n' | ${suffix}` });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(hooks);
		} finally {
			await f.close();
		}
	});
}

for (const [name, command, hooks] of [
	["bare quoted executable", "'node' -p 42", 0],
	["bare escaped executable", String.raw`n\ode -p 42`, 0],
	["quoted wrapper", "'nice' node -p 42", 0],
	["bare quoted argument", 'node -p "42"', 1],
	["wrapped quoted argument", 'nice node -p "42"', 1],
	["bare escaped argument", String.raw`node -p 4\2`, 1],
	["wrapped escaped argument", String.raw`nice node -p 4\2`, 1],
] as const) {
	it(`source allowance normalizes only the executable for ${name}`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: ["Bash(node -p 42)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(hooks);
		} finally {
			await f.close();
		}
	});
}

for (const prefix of ["FOO=bar", "NODE_ENV=test"]) {
	it(`${prefix} prefix allowance does not bypass the find exec approval requirement`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [`Bash(${prefix.split("=")[0]}=*)`] },
		});
		try {
			await f.run("bash", {
				command: String.raw`${prefix} find . -prune -exec node -p 42 \;`,
			});
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("42");
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}

for (const command of ["nice printf 'BLOCK'", String.raw`nice printf BL\OCK`]) {
	it(`source deny keeps wrapper argument spelling for ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { deny: ["Bash(printf BLOCK)"] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("BLOCK");
			expect(f.inputs()).toEqual([]);
		} finally {
			await f.close();
		}
	});
}

for (const [name, command, allow, hooks] of [
	["unapproved pipeline", "node -p 41 | cat", [], 1],
	["exact pipeline", "node -p 41 | cat", ["Bash(node -p 41 | cat)"], 1],
	["pipeline leaves", "node -p 41 | cat", ["Bash(node -p 41)", "Bash(cat)"], 0],
	["exact and chain", "node -p 41 && node -p 42", ["Bash(node -p 41 && node -p 42)"], 0],
	["exact subshell", "(node -p 42)", ["Bash((node -p 42))"], 1],
] as const) {
	it(`source whole command allowance respects ${name} boundaries`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [...allow] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain(name === "exact subshell" ? "42" : "41");
			expect(f.inputs()).toHaveLength(hooks);
		} finally {
			await f.close();
		}
	});
}

for (const behavior of ["deny", "ask"] as const) {
	for (const [name, command, matched] of [
		["joined nice option", "nice -n3 node -p 42", false],
		["time option", "time -p node -p 42", true],
		["spaced stdbuf option", "stdbuf -o L node -p 42", false],
	] as const) {
		it(`source ${behavior} uses its observed matching for ${name}`, async () => {
			const f = await fixture("claude", {
				mode: "full",
				rules: { [behavior]: ["Bash(node -p 42)"] },
			});
			try {
				await f.run("bash", { command });
				const result = f.session.messages.findLast((m) => m.role === "toolResult");
				expect(result).toMatchObject({
					isError: matched && behavior === "deny",
				});
				if (matched && behavior === "deny") expect(JSON.stringify(result)).toContain("Claude permission deny:");
				else expect(JSON.stringify(result)).toContain("42");
				expect(f.inputs()).toHaveLength(matched && behavior === "ask" ? 1 : 0);
			} finally {
				await f.close();
			}
		});
	}
}

for (const [name, command, rule, output] of [
	["leading-space prefix", String.raw` find . -prune -exec node -p 42 \;`, "Bash( find *)", "42"],
	[
		"leading-space exact",
		String.raw` find . -prune -exec node -p 42 \;`,
		String.raw`Bash( find . -prune -exec node -p 42 \;)`,
		"42",
	],
	["tab prefix", "\t" + String.raw`find . -prune -exec node -p 42 \;`, "Bash(\tfind *)", "42"],
	["quoted nice option", String.raw`nice "-n" 4 find . -prune -exec node -p 42 \;`, "Bash(nice *)", "42"],
	["unquoted nice option", String.raw`nice -n 4 find . -prune -exec node -p 42 \;`, "Bash(nice *)", "42"],
	[
		"quoted command option",
		String.raw`command "-p" find . -prune -exec /usr/bin/printf BLOCK \;`,
		"Bash(command *)",
		"BLOCK",
	],
] as const) {
	it(`${name} preserves the source find exec approval requirement`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [rule] },
		});
		try {
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain(output);
			expect(f.inputs()).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
}
