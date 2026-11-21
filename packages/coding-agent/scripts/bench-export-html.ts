/**
 * Server-side cost of exportFromFile by session size (B91): load, redact, JSON, base64 and template fill. The page parses
 * Markdown in the reader's browser, not here.
 *   node packages/coding-agent/scripts/bench-export-html.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OCTOCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bench-export-"));
const { exportFromFile } = await import("../src/core/export-html/index.ts");
const text = (i: number) =>
	`Result ${i}\n\n${"Lorem ipsum dolor sit amet, `code` and **bold**. ".repeat(60)}\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n`;
const cpuMs = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const dir = process.env.OCTOCODE_HOME;
for (const turns of [100, 1000, 5000]) {
	const file = path.join(dir, `s${turns}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: `s${turns}`, timestamp: new Date().toISOString(), cwd: dir }),
	];
	let parent: string | null = null;
	for (let i = 0; i < turns; i++)
		for (const [role, content] of [
			["user", [{ type: "text", text: `question ${i}` }]],
			["assistant", [{ type: "text", text: text(i) }]],
		] as const) {
			const id = `e${i}${role[0]}`;
			const message =
				role === "user"
					? { role, content, timestamp: Date.now() }
					: {
							role,
							content,
							api: "x",
							provider: "x",
							model: "x",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
			lines.push(
				JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message }),
			);
			parent = id;
		}
	fs.writeFileSync(file, lines.join("\n") + "\n");
	const out = path.join(dir, `s${turns}.html`);
	const c0 = cpuMs();
	const t0 = performance.now();
	await exportFromFile(file, out);
	console.log(
		JSON.stringify({
			turns,
			sessionMB: +(fs.statSync(file).size / 1e6).toFixed(2),
			htmlMB: +(fs.statSync(out).size / 1e6).toFixed(2),
			cpuMs: Math.round(cpuMs() - c0),
			wallMs: Math.round(performance.now() - t0),
			load1: os.loadavg()[0].toFixed(1),
		}),
	);
}
fs.rmSync(dir, { recursive: true, force: true });
