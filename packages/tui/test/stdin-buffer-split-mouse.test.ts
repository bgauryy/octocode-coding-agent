import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";

const REPORT = "\x1b[<64;12;5M";

describe("StdinBuffer split SGR mouse report", () => {
	let buffer: StdinBuffer;
	let out: string[];

	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		buffer = new StdinBuffer();
		out = [];
		buffer.on("data", (s) => out.push(s));
	});
	afterEach(() => {
		buffer.destroy();
		mock.timers.reset();
	});

	for (const gap of [0, 20, 80]) {
		for (let cut = 1; cut < REPORT.length; cut++) {
			it(`never emits mouse text when cut at byte ${cut} with a ${gap} ms gap`, () => {
				buffer.process(REPORT.slice(0, cut));
				mock.timers.tick(gap);
				buffer.process(REPORT.slice(cut));
				mock.timers.tick(500);
				// Every chunk is the whole report, or the ESC/ESC [ a flush emitted before the rest arrived: an ESC alone
				// past the escape timeout is the Escape key to the reader, which cannot know a report follows.
				const flushedLead = gap > 10 && cut <= 2 ? [REPORT.slice(0, cut)] : [];
				const allowed = [REPORT, ...flushedLead];
				assert.ok(
					out.every((chunk) => allowed.includes(chunk)),
					JSON.stringify(out),
				);
			});
		}
	}

	it("drops a report cut into three pieces", () => {
		buffer.process("\x1b");
		mock.timers.tick(20);
		buffer.process("[<64;1");
		mock.timers.tick(20);
		buffer.process("2;5M");
		mock.timers.tick(500);
		assert.ok(!out.join("").includes("[<"), JSON.stringify(out));
	});

	it("drops a cut report whose tail never arrives", () => {
		buffer.process("\x1b[<64;12");
		mock.timers.tick(500);
		assert.deepStrictEqual(out, []);
		assert.strictEqual(buffer.getBuffer(), "");
	});

	it("keeps digits and M typed well after a dropped report", () => {
		buffer.process("\x1b[<64");
		// Two ticks: a mocked timer callback reads the clock at the end of its tick.
		mock.timers.tick(60);
		mock.timers.tick(500);
		buffer.process("5");
		buffer.process("M");
		assert.deepStrictEqual(out, ["5", "M"]);
	});

	describe("after a dropped report head", () => {
		const drop = () => {
			buffer.process("\x1b[<0;1");
			mock.timers.tick(60);
		};

		it("types digits and a terminator that do not complete the report", () => {
			drop();
			buffer.process("5");
			buffer.process("m");
			mock.timers.tick(500);
			assert.strictEqual(out.join(""), "5m");
		});

		it("still drops the tail that completes it, in one chunk or several", () => {
			drop();
			buffer.process(";5M");
			drop();
			buffer.process(";");
			buffer.process("5");
			buffer.process("m");
			mock.timers.tick(500);
			assert.deepStrictEqual(out, []);
		});

		it("releases held digits when no terminator comes", () => {
			drop();
			buffer.process(";5");
			assert.deepStrictEqual(out, []);
			mock.timers.tick(500);
			assert.strictEqual(out.join(""), ";5");
		});

		it("keeps the text after a completed tail", () => {
			drop();
			buffer.process(";5Mab");
			assert.strictEqual(out.join(""), "ab");
		});
	});

	it("still emits a lone Escape", () => {
		buffer.process("\x1b");
		mock.timers.tick(20);
		assert.deepStrictEqual(out, ["\x1b"]);
	});

	it("keeps typed text after a lone Escape", () => {
		buffer.process("\x1b");
		mock.timers.tick(20);
		buffer.process("abc");
		assert.deepStrictEqual(out, ["\x1b", "abc"]);
	});

	it("keeps mouse-like text typed well after a real Escape", () => {
		buffer.process("\x1b");
		mock.timers.tick(20);
		mock.timers.tick(1000);
		buffer.process("[<1;2;3M");
		mock.timers.tick(500);
		assert.deepStrictEqual(out.join(""), "\x1b[<1;2;3M");
	});

	it("releases a held '[' that is not a mouse report", () => {
		buffer.process("\x1b");
		mock.timers.tick(20);
		buffer.process("[");
		mock.timers.tick(500);
		assert.deepStrictEqual(out, ["\x1b", "["]);
	});
});
