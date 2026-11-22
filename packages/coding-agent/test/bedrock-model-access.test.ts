import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	applyBedrockAccessCheck,
	bedrockModelAccess,
	preflightBedrockSelection,
} from "../src/core/bedrock-model-access.ts";

beforeEach(() => vi.stubEnv("OCTOCODE_OFFLINE", "0"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it.skipIf(process.platform === "win32")(
	"uses the selected profile, groups regional aliases and distinguishes a lookup refusal from a denied model",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-availability-"));
		try {
			const exe = join(dir, "aws");
			const log = join(dir, "requests");
			writeFileSync(
				exe,
				`#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]!=="bedrock"||args[args.indexOf("--profile")+1]!=="chosen")process.exit(2);
const profile=args[1]==="get-inference-profile";
const id=args[args.indexOf(profile?"--inference-profile-identifier":"--model-id")+1];require("node:fs").appendFileSync(${JSON.stringify(log)},id+"\\n");
if(profile){console.log(JSON.stringify({inferenceProfileId:id,status:"ACTIVE"}));process.exit(0);}
if(id==="vendor.unknown")process.exit(3);
console.log(JSON.stringify({modelId:id, agreementAvailability:{status:"AVAILABLE"},regionAvailability:"AVAILABLE",entitlementAvailability:"AVAILABLE",authorizationStatus:id==="zai.glm-5.3"?"NOT_AUTHORIZED":"AUTHORIZED"}));`,
			);
			chmodSync(exe, 0o700);
			vi.stubEnv("PATH", dir);
			const ids = ["global.zai.glm-5.3", "us.zai.glm-5.3", "global.moonshotai.kimi-k3.1", "vendor.unknown"];
			const models = ids.map((id) => ({ provider: "amazon-bedrock", id }));
			const results = await bedrockModelAccess(
				{ getAuth: async () => ({ auth: {}, env: { AWS_PROFILE: "chosen" } }) },
				models,
			);
			expect(models.map((m) => results.get(m))).toEqual([
				"account not authorized",
				"account not authorized",
				"entitled",
				expect.stringContaining("unverified"),
			]);
			expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual([
				"global.moonshotai.kimi-k3.1",
				"global.zai.glm-5.3",
				"moonshotai.kimi-k3.1",
				"us.zai.glm-5.3",
				"vendor.unknown",
				"zai.glm-5.3",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("looks up a bearer key directly in its region and treats a refused lookup as unknown", async () => {
	const model = { provider: "amazon-bedrock", id: "global.zai.glm-5.3" };
	const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
	const result = await bedrockModelAccess(
		{ getAuth: async () => ({ auth: { apiKey: "fixture" }, env: { AWS_REGION: "eu-west-1" } }) },
		[model],
		undefined,
		request,
	);
	expect(request).toHaveBeenCalledWith(
		"https://bedrock.eu-west-1.amazonaws.com/foundation-model-availability/zai.glm-5.3",
		expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer fixture" } }),
	);
	expect(result.get(model)).toBe("unverified (AWS lookup HTTP 403)");
});

const authorized = (id: string) => ({
	modelId: id,
	agreementAvailability: { status: "AVAILABLE" },
	regionAvailability: "AVAILABLE",
	entitlementAvailability: "AVAILABLE",
	authorizationStatus: "AUTHORIZED",
});
const runtime = () => ({
	modelAccessGeneration: 0,
	getAuth: async () => ({ auth: { apiKey: "fixture" }, env: { AWS_REGION: "us-east-1" } }),
	setModelAccess: vi.fn(),
	isModelAccessRejected: () => false,
});

it("refuses the exact EU profile when AWS cannot find it, while a US profile using the same foundation model is entitled", async () => {
	const base = "amazon.nova-pro-v1:0";
	const models = ["eu", "us"].map((prefix) => ({ provider: "amazon-bedrock", id: prefix + "." + base }));
	const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
		const path = decodeURIComponent(new URL(String(url)).pathname);
		if (path === "/foundation-model-availability/" + base) return Response.json(authorized(base));
		if (path === "/inference-profiles/" + models[0].id)
			return Response.json(
				{ message: "Not found" },
				{ status: 404, headers: { "x-amzn-errortype": "ResourceNotFoundException" } },
			);
		if (path === "/inference-profiles/" + models[1].id)
			return Response.json({ inferenceProfileId: models[1].id, status: "ACTIVE" });
		throw new Error("Unexpected lookup");
	});
	vi.stubGlobal("fetch", fetch);
	const registry = runtime();
	const result = await bedrockModelAccess(registry, models);
	expect(models.map((m) => result.get(m))).toEqual(["profile not found in region", "entitled"]);
	expect(fetch).toHaveBeenCalledTimes(3);
	await expect(preflightBedrockSelection(registry, models[0])).rejects.toThrow("Choose another model");
	expect(registry.setModelAccess).toHaveBeenCalledExactlyOnceWith(models[0], true, 0);
	applyBedrockAccessCheck(registry, models[1], result.get(models[1]), 0);
	expect(registry.setModelAccess).toHaveBeenLastCalledWith(models[1], false, 0);
});

it("does not turn control-plane permission failures into blocked selections or clear earlier rejections", async () => {
	const registry = runtime();
	const model = {
		provider: "custom",
		baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
		id: "us.zai.glm-5.3",
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 403 }));
	vi.stubGlobal("fetch", fetch);
	await expect(preflightBedrockSelection(registry, model)).resolves.toContain("unverified");
	expect(fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "bedrock.us-west-2.amazonaws.com")).toBe(
		true,
	);
	applyBedrockAccessCheck(registry, model, "unverified (AWS lookup HTTP 403)", 0);
	expect(registry.setModelAccess).not.toHaveBeenCalled();
	registry.isModelAccessRejected = () => true;
	await expect(preflightBedrockSelection(registry, model)).rejects.toThrow("previous request rejected");
});

it("bounds selection even if auth ignores cancellation, and propagates a dismissed picker", async () => {
	vi.useFakeTimers();
	const registry = { ...runtime(), getAuth: () => new Promise<never>(() => {}) };
	const model = { provider: "amazon-bedrock", id: "vendor.model" };
	const selected = preflightBedrockSelection(registry, model);
	await vi.advanceTimersByTimeAsync(2500);
	await expect(selected).resolves.toContain("timed out");
	const controller = new AbortController();
	const cancelled = preflightBedrockSelection(registry, model, controller.signal);
	controller.abort(new Error("picker closed"));
	await expect(cancelled).rejects.toThrow("picker closed");
	expect(registry.setModelAccess).not.toHaveBeenCalled();
});

it("never sends the credential to a custom endpoint or a hostname lookalike", async () => {
	const registry = runtime();
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	const lookalike = {
		provider: "custom",
		id: "us.vendor.model",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com.proxy.invalid/v1",
	};
	await expect(preflightBedrockSelection(registry, lookalike)).resolves.toBeUndefined();
	await expect(preflightBedrockSelection(registry, { ...lookalike, provider: "amazon-bedrock" })).resolves.toContain(
		"custom endpoint",
	);
	expect(fetch).not.toHaveBeenCalled();
});

it("skips automatic control-plane and auth work in offline mode", async () => {
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	const registry = { ...runtime(), getAuth: vi.fn() };
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	await expect(
		preflightBedrockSelection(registry, { provider: "amazon-bedrock", id: "us.vendor.model" }),
	).resolves.toContain("offline");
	expect(registry.getAuth).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it.each(["missing", "no local inference"])(
	"allows an active cross-region profile when the foundation model is %s locally",
	async (local) => {
		const model = { provider: "amazon-bedrock", id: "eu.amazon.nova-pro-v1:0" };
		const registry = {
			...runtime(),
			getAuth: async () => ({
				auth: { apiKey: "fixture", baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com" },
				env: { AWS_REGION: "us-east-1" },
			}),
		};
		const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
			if (new URL(String(url)).pathname.startsWith("/inference-profiles/"))
				return Response.json({ inferenceProfileId: model.id, status: "ACTIVE" });
			return local === "missing"
				? Response.json({ __type: "ResourceNotFoundException" }, { status: 404 })
				: Response.json({ ...authorized("amazon.nova-pro-v1:0"), regionAvailability: "NOT_AVAILABLE" });
		});
		vi.stubGlobal("fetch", fetch);
		await expect(preflightBedrockSelection(registry, model)).resolves.toContain("destination entitlement unknown");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "bedrock.eu-central-1.amazonaws.com"),
		).toBe(true);
		expect(registry.setModelAccess).not.toHaveBeenCalled();
	},
);

it("discards a rejection after account or endpoint configuration changes during a lookup", async () => {
	const registry = runtime();
	const wait = Promise.withResolvers<Response>();
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(() => wait.promise),
	);
	const model = { provider: "amazon-bedrock", id: "vendor.model" };
	const checking = preflightBedrockSelection(registry, model);
	registry.modelAccessGeneration++;
	wait.resolve(Response.json({ ...authorized(model.id), authorizationStatus: "NOT_AUTHORIZED" }));
	await expect(checking).resolves.toContain("configuration changed");
	expect(registry.setModelAccess).not.toHaveBeenCalled();
});

it("checks Mantle's exact model ID on its own Models API regardless of the inference path", async () => {
	const registry = runtime();
	const model = {
		provider: "fixture",
		id: "openai.gpt-5.4",
		baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/openai/v1",
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: model.id, status: "available" }));
	const result = await bedrockModelAccess(registry, [model], undefined, fetch);
	expect(result.get(model)).toBe("listed on Mantle");
	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		"https://bedrock-mantle.eu-west-1.api.aws/v1/models/openai.gpt-5.4",
		expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer fixture" } }),
	);
});
