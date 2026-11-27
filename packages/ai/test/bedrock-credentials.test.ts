import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream, type BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse, bedrockTextEvents } from "./bedrock-fixtures.ts";
const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function authorization(options: BedrockOptions = {}) {
	let auth: string | null = null;
	const result = await stream(bedrockModel, bedrockContext, {
		...options,
		fetch: async (_input, init) => {
			auth = new Headers(init?.headers).get("authorization");
			return bedrockResponse(bedrockTextEvents);
		},
	}).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return auth;
}
describe("Bedrock credential priority", () => {
	it.each([undefined, "ambient-profile"])("uses env keys with ambient profile %s", async (profile) => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-key");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		vi.stubEnv("AWS_PROFILE", profile);
		expect(await authorization()).toContain("Credential=ambient-key/");
	});
	it.each(["explicit", "scoped"])("uses %s profile over ambient keys", async (source) => {
		const dir = mkdtempSync(join(tmpdir(), "bedrock-auth-"));
		dirs.push(dir);
		const filepath = join(dir, "credentials");
		writeFileSync(filepath, "[fixture]\naws_access_key_id = profile-key\naws_secret_access_key = profile-secret\n");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-key");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		const env = {
			AWS_SHARED_CREDENTIALS_FILE: filepath,
			AWS_CONFIG_FILE: join(dir, "missing"),
			...(source === "scoped" ? { AWS_PROFILE: "fixture" } : {}),
		};
		expect(await authorization({ env, ...(source === "explicit" ? { profile: "fixture" } : {}) })).toContain(
			"Credential=profile-key/",
		);
	});
	it("uses scoped keys and session token", async () => {
		expect(
			await authorization({
				env: { AWS_ACCESS_KEY_ID: "scoped-key", AWS_SECRET_ACCESS_KEY: "scoped-secret", AWS_SESSION_TOKEN: "session" },
			}),
		).toContain("Credential=scoped-key/");
	});
	it("allows a dynamic credential provider", async () => {
		const provider = vi.fn(async () => ({ accessKeyId: "dynamic-key", secretAccessKey: "dynamic-secret" }));
		expect(await authorization({ credentialProvider: provider })).toContain("Credential=dynamic-key/");
		expect(provider).toHaveBeenCalledOnce();
	});
	it.each(["bearerToken", "apiKey", "env"])("uses bearer source %s without credentials", async (source) => {
		const options = source === "env" ? { env: { AWS_BEARER_TOKEN_BEDROCK: "real-token" } } : { [source]: "real-token" };
		expect(await authorization(options)).toBe("Bearer real-token");
	});
});
