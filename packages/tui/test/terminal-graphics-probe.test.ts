import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Image } from "../src/components/image.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import {
	detectCapabilities,
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilityOverrides,
	setProbedImageProtocol,
} from "../src/terminal-image/capabilities.ts";
import { KittyGraphicsProbe } from "../src/terminal-image/probe.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"OCTOCODE_IMAGE_PROTOCOL",
	"OCTOCODE_TRUE_COLOR",
	"OCTOCODE_HYPERLINKS",
	"OCTOCODE_PROGRAM_STATUS",
	"OCTOCODE_TUI_ESC_TIMEOUT",
];
const DA1 = "\x1b[?62;22c";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	setCapabilityOverrides({});
	resetCapabilitiesCache();
});
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	setCapabilityOverrides({});
	resetCapabilitiesCache();
});

function response(query: string, result = "OK"): string {
	const id = query.match(/\x1b_Gi=(\d+),a=q/)?.[1];
	assert.ok(id, "Expected a graphics query");
	return `\x1b_Gi=${id};${result}\x1b\\`;
}

describe("graphics capability detection", () => {
	it("recognizes TERM=xterm-kitty without local session variables", () => {
		process.env.TERM = "xterm-kitty";
		assert.equal(detectCapabilities().images, "kitty");
	});
	it("promotes an unknown terminal after a matching PNG acknowledgement", () => {
		const probe = new KittyGraphicsProbe();
		let changes = 0;
		const before = getCapabilities();
		const query = probe.start(true, () => changes++);
		assert.match(query, /a=q,t=d,f=100;/);
		assert.equal(probe.consume("\x1b_Gi=0;OK\x1b\\"), true);
		assert.equal(getCapabilities().images, null);
		assert.equal(probe.consume(response(query)), true);
		assert.deepEqual(getCapabilities(), { ...before, images: "kitty" });
		assert.equal(changes, 1);
		probe.finish();
		assert.equal(getCapabilities().images, "kitty");
	});
	for (const result of ["error", "missing"]) {
		it(`disables an environment hint after a ${result} graphics reply`, () => {
			process.env.TERM = "xterm-kitty";
			const probe = new KittyGraphicsProbe();
			let changes = 0;
			const query = probe.start(true, () => changes++);
			if (result === "error") probe.consume(response(query, "EINVAL: unsupported format"));
			probe.finish();
			assert.equal(getCapabilities().images, null);
			assert.equal(changes, 1);
			probe.consume(response(query));
			assert.equal(getCapabilities().images, null);
		});
	}
	it("accepts a delayed reply without a startup timer and ignores cancelled generations", async () => {
		const probe = new KittyGraphicsProbe();
		const old = probe.start(true);
		const current = probe.start(true);
		probe.consume(response(old));
		assert.equal(getCapabilities().images, null);
		await new Promise((resolve) => setTimeout(resolve, 20));
		probe.consume(response(current));
		assert.equal(getCapabilities().images, "kitty");
		resetCapabilitiesCache();
		probe.stop();
		probe.consume(response(current));
		assert.equal(getCapabilities().images, null);
	});
	for (const env of [
		{ TMUX: "/tmp/tmux", TERM_PROGRAM: "kitty" },
		{ TERM: "screen-256color" },
		{ TERM: "tmux-256color" },
		{ TERM_PROGRAM: "rex" },
		{ TERM_PROGRAM: "iTerm.app" },
		{ OCTOCODE_IMAGE_PROTOCOL: "kitty" },
		{ OCTOCODE_IMAGE_PROTOCOL: "iterm2" },
		{ OCTOCODE_IMAGE_PROTOCOL: "none" },
		{ OCTOCODE_IMAGE_PROTOCOL: "0" },
	]) {
		it(`keeps the configured fallback for ${JSON.stringify(env)}`, () => {
			Object.assign(process.env, env);
			assert.equal(new KittyGraphicsProbe().start(true), "");
		});
	}
	it("skips redirected streams and explicit settings, including changes during a probe", () => {
		const probe = new KittyGraphicsProbe();
		assert.equal(probe.start(false), "");
		const query = probe.start(true);
		setCapabilityOverrides({ images: null });
		probe.consume(response(query));
		assert.equal(getCapabilities().images, null);
		assert.equal(probe.start(true), "");
		setCapabilityOverrides({ images: "kitty" });
		assert.equal(probe.start(true), "");
		assert.equal(setProbedImageProtocol(null), false);
		assert.equal(getCapabilities().images, "kitty");
	});
});

function setup(isTTY = true) {
	const terminal = new ProcessTerminal();
	const writes: string[] = [];
	let data: ((value: string) => void) | undefined;
	const restore: Array<() => void> = [];
	const write = process.stdout.write;
	for (const stream of [process.stdin, process.stdout]) {
		const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
		Object.defineProperty(stream, "isTTY", { configurable: true, value: isTTY });
		restore.push(() =>
			descriptor ? Object.defineProperty(stream, "isTTY", descriptor) : Reflect.deleteProperty(stream, "isTTY"),
		);
	}
	const mocks = [
		mock.method(process.stdout, "write", (...args: Parameters<typeof process.stdout.write>) => {
			if (typeof args[0] !== "string") return write.apply(process.stdout, args);
			writes.push(args[0]);
			return true;
		}),
		mock.method(process.stdin, "on", (event: string, listener: (value: string) => void) => {
			if (event === "data") data = listener;
			return process.stdin;
		}),
		mock.method(process.stdin, "resume", () => process.stdin),
		mock.method(process.stdin, "removeListener", (event: string) => {
			if (event === "data") data = undefined;
			return process.stdin;
		}),
		mock.method(process.stdin, "pause", () => process.stdin),
	];
	return {
		terminal,
		writes,
		send: (value: string) => data?.(value),
		cleanup: () => {
			terminal.stop();
			for (const item of mocks) item.mock.restore();
			for (const item of restore) item();
		},
	};
}

describe("ProcessTerminal graphics negotiation", () => {
	it("shares DA1 with keyboard negotiation, reassembles split replies and preserves normal input", async () => {
		const h = setup();
		const input: string[] = [];
		let changes = 0;
		try {
			h.terminal.start(
				(value) => input.push(value),
				() => {},
				() => changes++,
			);
			const query = h.writes.find((write) => write.includes("a=q"))!;
			assert.equal(query.split("\x1b[c").length - 1, 1);
			const reply = response(query);
			const split = reply.indexOf(";") + 1;
			h.send("\x1b[?7u" + reply.slice(0, split));
			await new Promise((resolve) => setTimeout(resolve, 40));
			h.send(reply.slice(split) + DA1 + "x");
			assert.equal(h.terminal.kittyProtocolActive, true);
			assert.equal(getCapabilities().images, "kitty");
			assert.equal(changes, 1);
			assert.deepEqual(input, ["x"]);
			h.send(DA1);
			assert.deepEqual(input, ["x", DA1]);
		} finally {
			h.cleanup();
		}
	});
	it("uses text after DA1 without a graphics acknowledgement and ignores late replies after stop", () => {
		process.env.TERM = "xterm-kitty";
		const h = setup();
		try {
			h.terminal.start(
				() => {},
				() => {},
			);
			const query = h.writes.find((write) => write.includes("a=q"))!;
			h.send(DA1);
			assert.equal(getCapabilities().images, null);
			h.terminal.stop();
			h.send(response(query));
			assert.equal(getCapabilities().images, null);
		} finally {
			h.cleanup();
		}
	});
	it("does not emit a graphics query on redirected input or output", () => {
		const h = setup(false);
		try {
			h.terminal.start(
				() => {},
				() => {},
			);
			assert.equal(
				h.writes.some((write) => write.includes("a=q")),
				false,
			);
		} finally {
			h.cleanup();
		}
	});
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`repaints existing images when ${Renderer.name} learns graphics support`, async () => {
			const h = setup();
			const tui = new Renderer(h.terminal);
			try {
				tui.addChild(new Image(PNG, "image/png", { fallbackColor: (text) => text }));
				tui.start();
				await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(
					h.writes.some((write) => write.includes("a=T")),
					false,
				);
				h.send(response(h.writes.find((write) => write.includes("a=q"))!) + DA1);
				// The repaint is a throttled frame (at most one per 40 ms), so wait for it rather than a fixed time.
				const painted = () => h.writes.some((write) => write.includes("a=T") || write.includes("a=t"));
				for (const started = Date.now(); !painted() && Date.now() - started < 1_000;) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(
					h.writes.some((write) => write.includes("\x1b[16t")),
					true,
				);
				assert.equal(
					h.writes.some((write) => write.includes("a=T") || write.includes("a=t")),
					true,
				);
			} finally {
				tui.stop();
				h.cleanup();
			}
		});
	}
});
