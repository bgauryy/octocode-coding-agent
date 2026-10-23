import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

it("scoped Read denial prevents plain cat before broad Bash allowance or native full", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
		await f.run("bash", { command: "cat secret.txt" });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Claude permission deny:");
		expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const command of [
	"cat -- secret.txt",
	"cat 'secret.txt'",
	"command cat secret.txt",
	"cat safe.txt secret.txt",
	"head secret.txt",
	"head -n 1 secret.txt",
	"head -n1 secret.txt",
	"head -c 1 secret.txt",
	"head -1 secret.txt",
	"command head -n 1 secret.txt",
	"tail secret.txt",
	"tail -n 1 secret.txt",
	"tail -n +1 secret.txt",
	"tail -1 secret.txt",
	"command tail -n 1 secret.txt",
	"wc secret.txt",
	"wc -l secret.txt",
	"wc -- secret.txt",
	"command wc -l secret.txt",
]) {
	it(`scoped source Read denial preflights ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const [command, output] of [
	["cat safe.txt", "SAFE"],
	["printf SAFE | cat -", "SAFE"],
	["printf SAFE | wc -c", "4"],
	["head -n 1 safe.txt", "SAFE"],
	["tail -n 1 safe.txt", "SAFE"],
]) {
	it(`read operand control executes ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain(output);
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const command of ["head -n 1 safe.txt", "tail -n 1 safe.txt", "head -c 1 safe.txt"]) {
	it(`source-only numeric candidate matches vendor Read denial for ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: ["Read(./1)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const command of [
	"cat > effect.txt secret.txt",
	"head -n 1 > effect.txt secret.txt",
	"tail -n 1 > effect.txt secret.txt",
	"wc -l > effect.txt secret.txt",
]) {
	it(`read denial precedes redirected output for ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
			await f.run("bash", { command });
			expect(fs.existsSync(f.marker)).toBe(false);
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

it("read operand follows an existing symlink before source denial", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
		fs.symlinkSync(path.join(f.cwd, "secret.txt"), path.join(f.cwd, "alias.txt"));
		await f.run("bash", { command: "cat alias.txt" });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

it("dynamic read operand under applicable source denial refuses without leaking content", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
		await f.run("bash", { command: 'TARGET=secret.txt; cat "$TARGET"' });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const reader of ["head", "tail"]) {
	it(`numeric ${reader} option is source-policy-only and cannot add native file effects`, async () => {
		const f = await fixture("claude", {
			mode: "manual",
			rules: { allow: [`Bash(${reader} *)`, "Read(./safe.txt)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			const outside = path.join(f.root, "numeric-outside.txt");
			fs.writeFileSync(outside, "UNREAD_OUTSIDE");
			fs.symlinkSync(outside, path.join(f.cwd, "1"));
			await f.run("bash", { command: `${reader} -n 1 safe.txt` });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: false });
			expect(JSON.stringify(result)).toContain("SAFE");
			expect(JSON.stringify(result)).not.toContain("UNREAD_OUTSIDE");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

it("unknown indirect-reader option refuses explicitly under applicable Read denial", async () => {
	const f = await fixture("claude", {
		mode: "full",
		rules: { allow: ["Bash"], deny: ["Read(./secret.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "secret.txt"), "SECRET_FIXTURE\n");
		fs.writeFileSync(path.join(f.cwd, "list.txt"), "secret.txt\0");
		await f.run("bash", { command: "wc --files0-from=list.txt" });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(JSON.stringify(result)).toContain("Cannot resolve Bash file target for Read rule");
		expect(JSON.stringify(result)).not.toContain("illegal option");
		expect(JSON.stringify(result)).not.toContain("SECRET_FIXTURE");
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const reader of ["head", "tail"]) {
	it(`${reader} +1 remains visible to source Read rules`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: ["Read(./+1)"] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			fs.writeFileSync(path.join(f.cwd, "+1"), "PLUS_FILE_SECRET\n");
			await f.run("bash", { command: `${reader} +1 safe.txt` });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(JSON.stringify(result)).not.toContain("PLUS_FILE_SECRET");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

it("tail legacy +1 policy candidate does not become a native file effect", async () => {
	const f = await fixture("claude", {
		mode: "manual",
		rules: { allow: ["Bash(tail *)", "Read(./safe.txt)"] },
	});
	try {
		fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
		const outside = path.join(f.root, "plus-outside.txt");
		fs.writeFileSync(outside, "UNREAD_PLUS");
		fs.symlinkSync(outside, path.join(f.cwd, "+1"));
		await f.run("bash", { command: "tail +1 safe.txt" });
		const result = f.session.messages.findLast((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: false });
		expect(JSON.stringify(result)).toContain("SAFE");
		expect(JSON.stringify(result)).not.toContain("UNREAD_PLUS");
		expect(f.inputs()).toHaveLength(0);
	} finally {
		await f.close();
	}
});

for (const reader of ["head", "tail"]) {
	it.skipIf(process.platform !== "darwin")(
		`BSD ${reader} treats options after the first file as native read operands`,
		async () => {
			const f = await fixture("claude", {
				mode: "manual",
				rules: {
					allow: [`Bash(${reader} *)`, "Read(./safe.txt)", "Read(./1)"],
				},
			});
			try {
				fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
				fs.writeFileSync(path.join(f.cwd, "1"), "ONE\n");
				const outside = path.join(f.root, "option-outside.txt");
				fs.writeFileSync(outside, "OUTSIDE_OPTION\n");
				fs.symlinkSync(outside, path.join(f.cwd, "-n"));
				await f.run("bash", { command: `${reader} safe.txt -n 1` });
				const result = f.session.messages.findLast((m) => m.role === "toolResult");
				expect(result).toMatchObject({ isError: false });
				expect(JSON.stringify(result)).toContain("OUTSIDE_OPTION");
				expect(f.inputs()).toHaveLength(1);
			} finally {
				await f.close();
			}
		},
	);
}

for (const [command, denied] of [
	["head safe.txt -n 1", "-n"],
	["head safe.txt -n 1", "1"],
	["tail safe.txt -n 1", "-n"],
	["tail safe.txt -n 1", "1"],
	["cat safe.txt -n", "-n"],
	["wc safe.txt -l", "-l"],
]) {
	it(`source policy matches ${denied} after the first operand in ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: [`Read(./${denied})`] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "safe.txt"), "SAFE\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const [command, denied] of [
	["head -", "-"],
	["tail -", "-"],
	["wc -", "-"],
	["printf STDIN | cat - -n", "-n"],
]) {
	it(`source Read denial recognizes dash operands in ${command}`, async () => {
		const f = await fixture("claude", {
			mode: "full",
			rules: { allow: ["Bash"], deny: [`Read(./${denied})`] },
		});
		try {
			fs.writeFileSync(path.join(f.cwd, "-"), "DASH_SECRET\n");
			fs.writeFileSync(path.join(f.cwd, "-n"), "OPTION_SECRET\n");
			await f.run("bash", { command });
			const result = f.session.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Claude permission deny:");
			expect(JSON.stringify(result)).not.toContain("DASH_SECRET");
			expect(JSON.stringify(result)).not.toContain("OPTION_SECRET");
			expect(f.inputs()).toHaveLength(0);
		} finally {
			await f.close();
		}
	});
}

for (const reader of ["head", "tail", "wc"]) {
	it.skipIf(process.platform !== "darwin")(
		`BSD ${reader} dash operand retains actual outside-file approval`,
		async () => {
			const f = await fixture("claude", {
				mode: "manual",
				rules: { allow: [`Bash(${reader} *)`] },
			});
			try {
				const outside = path.join(f.root, "dash-outside.txt");
				fs.writeFileSync(outside, "DASH_SECRET\n");
				fs.symlinkSync(outside, path.join(f.cwd, "-"));
				await f.run("bash", { command: `${reader} -` });
				const result = f.session.messages.findLast((m) => m.role === "toolResult");
				expect(result).toMatchObject({ isError: false });
				expect(JSON.stringify(result)).toContain(reader === "wc" ? "12" : "DASH_SECRET");
				expect(f.inputs()).toHaveLength(1);
			} finally {
				await f.close();
			}
		},
	);
}
