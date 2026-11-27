import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBedrockClientConfig } from "../src/api/bedrock-converse-stream/client-config.ts";
import { bedrockModel } from "./bedrock-fixtures.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const env = { AWS_REGION: "", AWS_DEFAULT_REGION: "", AWS_PROFILE: "", AWS_CONFIG_FILE: "/nonexistent/bedrock/config" };
describe("Bedrock endpoint and region resolution", () => {
	it("routes the built-in EU inference profile to eu-central-1", () => {
		const model = getBuiltinModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");
		expect(model.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		const config = buildBedrockClientConfig(model, { env });
		expect(config.region).toBe("eu-central-1");
		expect(config.baseURL).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});
	it("derives region from a standard EU endpoint", () => {
		const config = buildBedrockClientConfig(
			{ ...bedrockModel, baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com" },
			{ env },
		);
		expect(config.region).toBe("eu-central-1");
		expect(config.baseURL).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});
	it("uses env region rather than pinning a catalog endpoint", () => {
		const config = buildBedrockClientConfig(bedrockModel, { env: { ...env, AWS_REGION: "us-east-2" } });
		expect(config.region).toBe("us-east-2");
		expect(config.baseURL).toBeUndefined();
	});
	it("preserves custom endpoints", () => {
		const config = buildBedrockClientConfig(
			{ ...bedrockModel, baseUrl: "https://bedrock-vpc.example.com" },
			{ env: { ...env, AWS_REGION: "us-west-2" } },
		);
		expect(config.baseURL).toBe("https://bedrock-vpc.example.com");
		expect(config.region).toBe("us-west-2");
	});
	it.each(["aws", "aws-us-gov"])("prefers %s ARN region over env", (partition) => {
		const region = partition === "aws" ? "us-west-2" : "us-gov-west-1";
		expect(
			buildBedrockClientConfig(
				{ ...bedrockModel, id: `arn:${partition}:bedrock:${region}:123:application-inference-profile/x` },
				{ env: { ...env, AWS_REGION: "us-east-1" } },
			).region,
		).toBe(region);
	});
	it("reads only the selected profile region and honors option/env priority", () => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-region-"));
		dirs.push(dir);
		const path = join(dir, "config");
		writeFileSync(path, "# config\n[default]\nregion = eu-west-1\n[profile fixture]\nregion = ap-south-1 ; comment\n");
		const scoped = { ...env, AWS_CONFIG_FILE: path };
		expect(buildBedrockClientConfig(bedrockModel, { env: scoped }).region).toBe("eu-west-1");
		expect(buildBedrockClientConfig(bedrockModel, { profile: "fixture", env: scoped }).region).toBe("ap-south-1");
		expect(buildBedrockClientConfig(bedrockModel, { env: { ...scoped, AWS_PROFILE: "fixture" } }).region).toBe(
			"ap-south-1",
		);
		expect(buildBedrockClientConfig(bedrockModel, { env: { ...scoped, AWS_REGION: "us-west-1" } }).region).toBe(
			"us-west-1",
		);
		expect(buildBedrockClientConfig(bedrockModel, { env: { ...scoped, AWS_DEFAULT_REGION: "us-east-2" } }).region).toBe(
			"us-east-2",
		);
		expect(
			buildBedrockClientConfig(bedrockModel, { region: "us-west-2", env: { ...scoped, AWS_REGION: "us-west-1" } })
				.region,
		).toBe("us-west-2");
	});
	it.each(["missing", "malformed"])("falls back for a %s config without leaking contents", (kind) => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-region-"));
		dirs.push(dir);
		const path = join(dir, "config");
		if (kind === "malformed") writeFileSync(path, "[default\nregion = secret contents");
		expect(buildBedrockClientConfig(bedrockModel, { env: { ...env, AWS_CONFIG_FILE: path } }).region).toBe("us-east-1");
	});
});
