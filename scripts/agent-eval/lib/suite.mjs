/** The task suite: load, validate, select, order, fingerprint. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const GRADER_TYPES = new Set(["facts", "command", "changedPaths", "child"]);
const SPLITS = new Set(["dev", "heldout"]);

export function loadSuite(file) {
	const path = resolve(file);
	const suite = JSON.parse(readFileSync(path, "utf8"));
	const problems = [];
	if (typeof suite.ref !== "string") problems.push("suite has no ref");
	const ids = new Set();
	for (const task of suite.tasks ?? []) {
		if (ids.has(task.id)) problems.push(`duplicate task id ${task.id}`);
		ids.add(task.id);
		if (!SPLITS.has(task.split)) problems.push(`${task.id}: split must be dev or heldout`);
		if (typeof task.prompt !== "string" || !task.prompt.trim()) problems.push(`${task.id}: no prompt`);
		if (!Array.isArray(task.graders) || task.graders.length === 0) problems.push(`${task.id}: no graders`);
		for (const grader of task.graders ?? []) {
			if (!GRADER_TYPES.has(grader.type)) problems.push(`${task.id}: unknown grader ${grader.type}`);
		}
	}
	if (problems.length > 0) throw new Error(`invalid suite ${path}:\n  ${problems.join("\n  ")}`);
	return { ...suite, path, dir: dirname(path) };
}

export function selectTasks(suite, { split = "dev", ids } = {}) {
	if (ids?.length) {
		const known = new Set(suite.tasks.map((task) => task.id));
		const unknown = ids.filter((id) => !known.has(id));
		if (unknown.length > 0) throw new Error(`unknown task ids: ${unknown.join(", ")}`);
		return suite.tasks.filter((task) => ids.includes(task.id));
	}
	return split === "all" ? suite.tasks : suite.tasks.filter((task) => task.split === split);
}

/** A small seeded generator, so both arms see the same order and a bootstrap repeats. */
export function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

/** Every trial in run order: each run walks all tasks, shuffled by the seed. */
export function planTrials(tasks, { runs, seed = 1 }) {
	const random = seededRandom(seed);
	const trials = [];
	for (let run = 1; run <= runs; run++) {
		const order = [...tasks];
		for (let index = order.length - 1; index > 0; index--) {
			const other = Math.floor(random() * (index + 1));
			[order[index], order[other]] = [order[other], order[index]];
		}
		for (const task of order) trials.push({ task, run, id: `${task.id}-r${run}` });
	}
	return trials;
}

function hashFiles(root, entries) {
	const hash = createHash("sha256");
	const visit = (path) => {
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(join(path, name));
			return;
		}
		hash.update(relative(root, path));
		hash.update(readFileSync(path));
	};
	for (const entry of entries) visit(join(root, entry));
	return hash.digest("hex");
}

/** What decides a score: tasks, patches and checks. Arms with different hashes are not comparable. */
export const suiteHash = (suite) => {
	const entries = readdirSync(suite.dir).filter((name) => name === "fixtures");
	const hash = createHash("sha256");
	hash.update(readFileSync(suite.path));
	hash.update(hashFiles(suite.dir, entries));
	return hash.digest("hex");
};

/** The runner and graders themselves. */
export const harnessHash = () => {
	const kit = resolve(import.meta.dirname, "..");
	return hashFiles(kit, ["lib", "run.mjs"]);
};
