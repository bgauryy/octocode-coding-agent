import { Text } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { InputProvider, type InputSource, parseWheel, useInputHandler } from "../src/input.tsx";

function source(): InputSource & { send(data: string): boolean } {
	let listener: ((data: string) => boolean) | undefined;
	return {
		subscribe: (next) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		send: (data) => listener?.(data) ?? false,
	};
}

function Typed({ consume, label }: { consume: (data: string) => boolean; label: string }) {
	const [text, setText] = useState("");
	useInputHandler((data) => {
		if (!consume(data)) return false;
		setText((value) => value + data);
		return true;
	});
	return <Text>{`${label}:${text}`}</Text>;
}

describe("InputProvider", () => {
	it("gives each key to the newest handler first and passes what it declines down the stack", async () => {
		const input = source();
		const { lastFrame } = render(
			<InputProvider source={input}>
				<Typed label="below" consume={() => true} />
				<Typed label="top" consume={(data) => data === "a"} />
			</InputProvider>,
		);
		expect(input.send("a")).toBe(true);
		expect(input.send("b")).toBe(true);
		await vi.waitFor(() => expect(lastFrame()).toBe("below:b\ntop:a"));
	});

	it("reports unconsumed input so the legacy focus target still receives it", () => {
		const input = source();
		render(
			<InputProvider source={input}>
				<Typed label="only" consume={() => false} />
			</InputProvider>,
		);
		expect(input.send("\x1b[200~pasted\x1b[201~")).toBe(false);
	});

	it("stops delivering after unmount", () => {
		const input = source();
		const seen: string[] = [];
		function Spy() {
			useInputHandler((data) => {
				seen.push(data);
				return true;
			});
			return null;
		}
		const { unmount } = render(
			<InputProvider source={input}>
				<Spy />
			</InputProvider>,
		);
		input.send("x");
		unmount();
		expect(input.send("y")).toBe(false);
		expect(seen).toEqual(["x"]);
	});
});

describe("parseWheel", () => {
	it("reads SGR wheel reports and ignores clicks and keys", () => {
		expect(parseWheel("\x1b[<64;10;5M")).toBe(-1);
		expect(parseWheel("\x1b[<65;10;5M")).toBe(1);
		expect(parseWheel("\x1b[<0;10;5M")).toBeUndefined();
		expect(parseWheel("a")).toBeUndefined();
	});
});
