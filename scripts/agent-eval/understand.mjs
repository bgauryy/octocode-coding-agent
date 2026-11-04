#!/usr/bin/env node
/**
 * Do agents understand their instructions? Sends a small model each agent's exact final prompt, tools and first message
 * (`.octocode/tmp/agent-prompts/`, written by every build) with a question about how it would work, and grades the answer.
 * A wrong answer points at an instruction to improve. Spending needs `--live --max-usd <n>`; see README.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const KIT = import.meta.dirname;
const REPO = resolve(KIT, "..", "..");
const PLACEHOLDER = /\[The (?:user's first message|parent's task:[^\]]*)\]/;
const PREFACE =
	"Do not act and do not call a tool. Answer this question about how you would work, from your instructions and tools alone, in at most three sentences, naming the exact tool and fields. If your instructions do not say, answer NOT STATED.";
const UNCLEAR =
	"List up to five things in your instructions or tools that are unclear, contradict each other or are hard to follow, each with the words that cause it. Bracketed and angle-bracket values such as [the goal] or <platform> are filled in when you run: ignore them. Answer NONE if there are none.";

/** Whether `answer` meets a question's `expect` and `forbid` patterns, and which ones it missed. */
export function gradeAnswer(question, answer) {
	const hit = (pattern) => new RegExp(pattern, "i").test(answer);
	const missed = (question.expect ?? []).filter((pattern) => !hit(pattern));
	const forbidden = (question.forbid ?? []).filter(hit);
	return { pass: missed.length === 0 && forbidden.length === 0, missed, forbidden };
}

/** The questions for one agent: those naming it, by its name or a group. */
export function questionsFor(bank, agent) {
	const groups = Object.entries(bank.groups)
		.filter(([, members]) => members.includes(agent))
		.map(([group]) => group);
	return bank.questions.filter((question) => question.agents.some((name) => name === agent || groups.includes(name)));
}

/** The first message with the question where the user or parent would have written. */
export function firstMessage(request, question) {
	const asked = `${PREFACE}\n\nQuestion: ${question}`;
	const text = request.messages[0]?.text ?? "";
	return PLACEHOLDER.test(text) ? text.replace(PLACEHOLDER, () => asked) : `${text}\n\n${asked}`;
}

async function ask({ provider, model, request, question }) {
	const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": provider.apiKey },
		body: JSON.stringify({
			model: model.id,
			// Room for the model's own thinking as well as a short answer: a low limit returns nothing and looks like a wrong answer.
			max_tokens: 4000,
			system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
			tools: request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			})),
			tool_choice: { type: "none" },
			messages: [{ role: "user", content: firstMessage(request, question) }],
		}),
	});
	const body = await response.json();
	if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
	const usage = body.usage ?? {};
	const rate = model.cost ?? {};
	const cost =
		((usage.input_tokens ?? 0) * (rate.input ?? 0) +
			(usage.output_tokens ?? 0) * (rate.output ?? 0) +
			(usage.cache_read_input_tokens ?? 0) * (rate.cacheRead ?? 0) +
			(usage.cache_creation_input_tokens ?? 0) * (rate.cacheWrite ?? 0)) /
		1_000_000;
	return { text: (body.content ?? []).map((part) => part.text ?? "").join(""), cost };
}

function report(rows, unclear, spent, modelId) {
	const passed = rows.filter((row) => row.pass).length;
	const agents = [...new Set(rows.map((row) => row.agent))];
	const lines = [
		`# Do agents understand their instructions?`,
		"",
		`${passed}/${rows.length} answers correct on ${modelId}, $${spent.toFixed(3)}. ${rows.filter((row) => row.error).length} could not be asked (an error, not a wrong answer).`,
		"",
		"| Agent | Correct |",
		"| --- | --- |",
		...agents.map((agent) => {
			const own = rows.filter((row) => row.agent === agent);
			return `| ${agent} | ${own.filter((row) => row.pass).length}/${own.length} |`;
		}),
		"",
		"## Wrong answers",
		"",
		...rows.flatMap((row) =>
			row.pass
				? []
				: [
						`### ${row.agent}: ${row.id}`,
						"",
						`**Question:** ${row.question}`,
						"",
						`**Answer:** ${row.answer}`,
						"",
						`**Missing:** ${row.missed.join(", ") || "-"}. **Should not say:** ${row.forbidden.join(", ") || "-"}.`,
						"",
					],
		),
		"## What each agent found unclear",
		"",
		...unclear.flatMap((row) => [`### ${row.agent}`, "", row.answer, ""]),
	];
	return `${lines.join("\n")}\n`;
}

async function main() {
	const { values } = parseArgs({
		options: {
			live: { type: "boolean" },
			"max-usd": { type: "string" },
			provider: { type: "string" },
			model: { type: "string", default: "claude-haiku-5-5" },
			"models-file": { type: "string", default: join(homedir(), ".pi", "agent", "models.json") },
			prompts: { type: "string", default: join(REPO, ".octocode", "tmp", "agent-prompts") },
			questions: { type: "string", default: join(KIT, "understanding.json") },
			out: { type: "string" },
			agents: { type: "string" },
			concurrency: { type: "string", default: "4" },
		},
	});
	const bank = JSON.parse(readFileSync(values.questions, "utf8"));
	const agents = values.agents?.split(",") ?? [...new Set(Object.values(bank.groups).flat())];
	const jobs = agents.flatMap((agent) => questionsFor(bank, agent).map((question) => ({ agent, question })));
	if (!values.live || !values["max-usd"] || !values.provider) {
		console.log(`${jobs.length} questions and ${agents.length} unclear checks for ${agents.join(", ")}.`);
		console.log("Refused: live runs spend money. Pass --live --max-usd <n> --provider <name from models.json>.");
		process.exit(2);
	}
	const maxUsd = Number(values["max-usd"]);
	if (!(maxUsd > 0)) throw new Error("--max-usd must be a positive number");
	const provider = JSON.parse(readFileSync(values["models-file"], "utf8")).providers?.[values.provider];
	const model = provider?.models?.find((candidate) => candidate.id === values.model);
	if (!model) throw new Error(`No model ${values.model} under provider ${values.provider} in ${values["models-file"]}`);
	const requestOf = (agent) => {
		const file = join(values.prompts, agent, "request.json");
		if (!existsSync(file)) throw new Error(`Missing ${file}: run a build or generate:prompts first.`);
		return JSON.parse(readFileSync(file, "utf8"));
	};
	const requests = new Map(agents.map((agent) => [agent, requestOf(agent)]));
	let spent = 0;
	const queue = [
		...jobs,
		...agents.map((agent) => ({ agent, question: { id: "unclear", question: UNCLEAR, unclear: true } })),
	];
	const rows = [];
	const unclear = [];
	const worker = async () => {
		while (queue.length > 0 && spent < maxUsd) {
			const { agent, question } = queue.shift();
			try {
				const call = () => ask({ provider, model, request: requests.get(agent), question: question.question });
				let { text, cost } = await call();
				spent += cost;
				if (!text.trim()) {
					({ text, cost } = await call());
					spent += cost;
				}
				if (!text.trim()) throw new Error("the model returned no text, twice");
				if (question.unclear) unclear.push({ agent, answer: text });
				else
					rows.push({
						agent,
						id: question.id,
						question: question.question,
						answer: text,
						...gradeAnswer(question, text),
					});
			} catch (error) {
				rows.push({
					agent,
					id: question.id,
					question: question.question,
					answer: `ERROR ${error.message}`,
					error: true,
					pass: false,
					missed: [],
					forbidden: [],
				});
			}
		}
	};
	await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
	const stopped = queue.length > 0;
	const out = values.out ?? join(REPO, ".octocode", "tmp", "prompt-understanding");
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "results.json"), `${JSON.stringify({ rows, unclear, spent, stopped }, null, "\t")}\n`);
	writeFileSync(join(out, "report.md"), report(rows, unclear, spent, model.id));
	console.log(
		`${rows.filter((row) => row.pass).length}/${rows.length} correct, $${spent.toFixed(3)}${stopped ? " (stopped at the limit)" : ""}. Report: ${join(out, "report.md")}`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
