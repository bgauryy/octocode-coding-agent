import { describe, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import type { Permission } from "../../src/octocode/permission/ask.ts";
import { approveFetch } from "../../src/octocode/native/tools/web/tool.ts";
import { pageFetcher } from "../../src/octocode/web/fetch.ts";
import type { HostLookup } from "@octocodeai/octocode-common/web-guard";

const ctx = { cwd: "/tmp" } as FeatureContext;
const allowing = (): Permission =>
	({ check: async () => ({ allowed: true }), refused: () => undefined }) as unknown as Permission;

describe("approving a fetch resolves the host once, inside the deadline", () => {
	it("ends at the deadline with the usual timeout message when the resolver never answers", async () => {
		const calls: string[] = [];
		const lookup: HostLookup = (name) => {
			calls.push(name);
			return new Promise(() => undefined);
		};
		await expect(
			approveFetch(allowing(), ctx, "id", "http://blackhole.test/page", undefined, { lookup, timeoutMs: 50 }),
		).rejects.toThrow("Timed out after 0.05s fetching http://blackhole.test/page");
		expect(calls).toEqual(["blackhole.test"]);
	});

	it("looks the host up once for the metadata check and the private-address check together", async () => {
		const calls: string[] = [];
		const lookup: HostLookup = async (name) => {
			calls.push(name);
			return [{ address: "93.184.216.34" }];
		};
		await expect(
			approveFetch(allowing(), ctx, "id", "http://public.test/", undefined, { lookup }),
		).resolves.toMatchObject({
			private: false,
		});
		expect(calls).toHaveLength(1);
	});
});

describe("approve and fetch share one resolution", () => {
	it("passes the approved addresses to the first request", async () => {
		const seen: Array<{ addresses?: string[] }> = [];
		const fetcher = pageFetcher();
		const options = { addresses: ["93.184.216.34"] };
		const guard = await import("@octocodeai/octocode-common/web-guard");
		const spy = vi.spyOn(guard, "publicFetch").mockImplementation(async (_url, _init, opts) => {
			seen.push({ addresses: opts?.firstHopAddresses });
			return new Response("hello", { headers: { "content-type": "text/plain" } });
		});
		try {
			await fetcher("http://public.test/", undefined, options);
		} finally {
			spy.mockRestore();
		}
		expect(seen).toEqual([{ addresses: ["93.184.216.34"] }]);
	});

	it("approveFetch returns the addresses it resolved", async () => {
		const lookup: HostLookup = async () => [{ address: "93.184.216.34" }];
		await expect(approveFetch(allowing(), ctx, "id", "http://public.test/", undefined, { lookup })).resolves.toEqual({
			private: false,
			addresses: ["93.184.216.34"],
		});
	});
});
