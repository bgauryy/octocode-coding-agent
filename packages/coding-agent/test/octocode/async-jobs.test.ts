import { describe, expect, it, vi } from "vitest";
import { AsyncJobs, type JobOutcome, type JobPorts } from "../../src/octocode/jobs/async-jobs.ts";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";

const gate = () => {
	let release: (value: string) => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	const promise = new Promise<string>((resolve, reject) => {
		release = resolve;
		fail = reject;
	});
	return { promise, release, fail };
};

function attached() {
	const delivered: Array<{ id: string; outcome: JobOutcome }> = [];
	const failures: unknown[] = [];
	const work = new RunningWork();
	const ports: JobPorts = {
		deliver: (job, outcome) => void delivered.push({ id: job.id, outcome }),
		failed: (_job, error) => void failures.push(error),
		work,
	};
	const jobs = new AsyncJobs();
	jobs.attach(ports);
	return { jobs, delivered, failures, work, ports };
}

const spec = (foregroundMs: number, signal?: AbortSignal) => ({
	tool: "web",
	title: "fetch a page",
	foregroundMs,
	...(signal ? { signal } : {}),
});

describe("AsyncJobs.run", () => {
	it("returns the value of work that ends within the budget and starts no job", async () => {
		const { jobs, delivered } = attached();
		const started = await jobs.run(spec(1000), async () => "fast");
		expect(started).toEqual({ status: "done", value: "fast" });
		expect(jobs.running()).toEqual([]);
		expect(delivered).toEqual([]);
	});

	it("throws the error of work that fails within the budget", async () => {
		const { jobs, delivered } = attached();
		await expect(
			jobs.run(spec(1000), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(delivered).toEqual([]);
	});

	it("turns work that outlasts the budget into a job and reports its value once", async () => {
		const { jobs, delivered, work } = attached();
		const slow = gate();
		const started = await jobs.run(spec(5), () => slow.promise);
		if (started.status !== "job") throw new Error("expected a job");
		expect(started.job.id).toBe("task-1");
		expect(work.all().map((row) => [row.kind, row.id])).toEqual([["job", "task-1"]]);
		slow.release("late");
		await jobs.settle();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ id: "task-1", outcome: { kind: "done", value: "late" } });
		expect(work.all()).toEqual([]);
	});

	it("reports a job's failure instead of dropping it", async () => {
		const { jobs, delivered } = attached();
		const slow = gate();
		await jobs.run(spec(5), () => slow.promise);
		slow.fail(new Error("server gone"));
		await jobs.settle();
		expect(delivered[0].outcome).toMatchObject({ kind: "failed" });
	});

	it("aborts the work with the call's signal while the call waits", async () => {
		const { jobs, delivered } = attached();
		const call = new AbortController();
		const running = jobs.run(spec(10_000, call.signal), (signal) => {
			return new Promise<string>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		call.abort();
		await expect(running).rejects.toThrow("aborted");
		expect(delivered).toEqual([]);
	});

	it("no longer follows the call's signal once the work is a job", async () => {
		const { jobs } = attached();
		const call = new AbortController();
		const seen = vi.fn();
		const slow = gate();
		const started = await jobs.run(spec(5, call.signal), (signal) => {
			signal.addEventListener("abort", seen);
			return slow.promise;
		});
		expect(started.status).toBe("job");
		call.abort();
		expect(seen).not.toHaveBeenCalled();
		slow.release("ok");
		await jobs.settle();
	});

	it("keeps the call waiting when no session is attached to receive a report", async () => {
		const jobs = new AsyncJobs();
		const slow = gate();
		const running = jobs.run(spec(1), () => slow.promise);
		await new Promise((resolve) => setTimeout(resolve, 20));
		slow.release("waited");
		expect(await running).toEqual({ status: "done", value: "waited" });
	});
});

describe("AsyncJobs stop", () => {
	const longJob = async (jobs: AsyncJobs) => {
		let aborted = false;
		const started = await jobs.run(spec(1), (signal) => {
			return new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve("ignored");
				});
			});
		});
		if (started.status !== "job") throw new Error("expected a job");
		return { job: started.job, aborted: () => aborted };
	};

	it("aborts the work and reports a stop, not a result, when the user cancels the row", async () => {
		const { jobs, delivered, work } = attached();
		const { job, aborted } = await longJob(jobs);
		expect(work.cancel("job", job.id, undefined)).toBe(true);
		await jobs.settle();
		expect(aborted()).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].outcome).toMatchObject({ kind: "stopped", by: "user" });
	});

	it("stops every job at the session's end and reports each once", async () => {
		const { jobs, delivered } = attached();
		await longJob(jobs);
		await longJob(jobs);
		await jobs.stopAll("session end");
		expect(jobs.running()).toEqual([]);
		expect(delivered.map((entry) => entry.outcome.kind)).toEqual(["stopped", "stopped"]);
	});

	it("says so when a report cannot be delivered", async () => {
		const { jobs, failures, ports } = attached();
		ports.deliver = () => {
			throw new Error("session gone");
		};
		const slow = gate();
		await jobs.run(spec(1), () => slow.promise);
		slow.release("x");
		await jobs.settle();
		expect(failures).toHaveLength(1);
	});

	it("refuses to stop a job that already ended", async () => {
		const { jobs } = attached();
		const { job } = await longJob(jobs);
		expect(jobs.stop(job.id, "user")).toBe(true);
		expect(jobs.stop(job.id, "user")).toBe(false);
	});
});
