import { afterEach, expect, it, vi } from "vitest";
import { processStartAsync } from "../src/process-start.ts";
import { keepOwnStart, keptOwnStart, ownStartAsync, resetOwnStart } from "../src/own-start.ts";

vi.mock("../src/process-start.ts", () => ({ processStartAsync: vi.fn() }));

afterEach(() => {
	resetOwnStart();
	vi.mocked(processStartAsync).mockReset();
});

it("reads this process's start once for every caller and keeps the answer", async () => {
	vi.mocked(processStartAsync).mockResolvedValue({ started: "1700000000", zombie: false });
	expect(keptOwnStart()).toBeUndefined();
	const answers = await Promise.all(Array.from({ length: 5 }, () => ownStartAsync()));
	expect(answers).toEqual(Array(5).fill("1700000000"));
	expect(await ownStartAsync()).toBe("1700000000");
	expect(keptOwnStart()).toEqual({ started: "1700000000" });
	expect(processStartAsync).toHaveBeenCalledTimes(1);
	expect(processStartAsync).toHaveBeenCalledWith(process.pid);
});

it("keeps a failed read too, and a value a caller read itself, without another ps", async () => {
	vi.mocked(processStartAsync).mockResolvedValue(undefined);
	expect(await ownStartAsync()).toBeUndefined();
	expect(keptOwnStart()).toEqual({ started: undefined });
	resetOwnStart();
	keepOwnStart("1700000001");
	expect(await ownStartAsync()).toBe("1700000001");
	expect(processStartAsync).toHaveBeenCalledTimes(1);
});
