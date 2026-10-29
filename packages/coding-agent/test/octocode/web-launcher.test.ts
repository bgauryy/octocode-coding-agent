import { expect, it, vi } from "vitest";
import { webLauncher } from "../../src/octocode/shared/web.ts";
import { fakeHost } from "./fake-host.ts";

it("revalidates a cached shared endpoint and replaces an unhealthy owner", async () => {
	const fake = fakeHost();
	const opened: string[] = [];
	const first = {
		url: "http://one",
		close: vi.fn(async () => undefined),
		validate: vi.fn(async () => false),
	};
	const second = {
		url: "http://two",
		close: vi.fn(async () => undefined),
		validate: vi.fn(async () => true),
	};
	const launch = webLauncher(fake.api, async (url) => {
		opened.push(url);
	});
	await launch("repo", async () => first, "activity");
	await launch("repo", async () => second, "activity");
	await launch("repo", async () => second, "activity");
	expect(opened).toEqual(["http://one/#view=activity", "http://two/#view=activity", "http://two/#view=activity"]);
	expect(first.close).toHaveBeenCalledOnce();
	expect(second.close).not.toHaveBeenCalled();
});
