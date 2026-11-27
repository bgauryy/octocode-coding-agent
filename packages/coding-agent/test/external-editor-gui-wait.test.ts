import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

beforeEach(() => {
	spawn.mockReset();
	spawn.mockImplementation(() => {
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	});
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

const argsOf = async (command: string): Promise<string[]> => {
	await editInExternalEditor({ command, content: "draft" });
	return spawn.mock.calls[0][1].slice(0, -1);
};

it("waits for a GUI prompt editor that would otherwise return at once", async () => {
	expect(await argsOf("code")).toEqual(["--wait"]);
	spawn.mockClear();
	expect(await argsOf("zed --new")).toEqual(["--new", "--wait"]);
});

it("keeps a configured wait flag and leaves terminal editors alone", async () => {
	expect(await argsOf("code -w")).toEqual(["-w"]);
	spawn.mockClear();
	expect(await argsOf("cursor --wait")).toEqual(["--wait"]);
	spawn.mockClear();
	expect(await argsOf("vim")).toEqual([]);
});
