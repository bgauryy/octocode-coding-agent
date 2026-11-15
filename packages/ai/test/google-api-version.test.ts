import type * as GoogleGenAi from "@google/genai";
import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => [] as Array<{ httpOptions?: { apiVersion?: string; baseUrl?: string } }>);

vi.mock("@google/genai", async (importOriginal) => {
	const original = await importOriginal<typeof GoogleGenAi>();
	class CapturingGenAI {
		models = {
			generateContentStream: async () => {
				throw new Error("request captured");
			},
		};
		constructor(options: { httpOptions?: { apiVersion?: string; baseUrl?: string } }) {
			constructed.push(options);
		}
	}
	return { ...original, GoogleGenAI: CapturingGenAI };
});

const { streamSimple } = await import("../src/compat.ts");
const { getBuiltinModel } = await import("../src/providers/all.ts");

async function clientOptions(baseUrl?: string) {
	constructed.length = 0;
	const base = getBuiltinModel("google", "gemini-2.5-flash");
	await streamSimple(
		{ ...base, ...(baseUrl === undefined ? {} : { baseUrl }) },
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "k" },
	).result();
	return constructed[0]?.httpOptions;
}

describe("Google Generative AI API version", () => {
	it("pins v1beta when no base URL is configured", async () => {
		const options = await clientOptions("");
		expect(options?.apiVersion).toBe("v1beta");
		expect(options?.baseUrl).toBeUndefined();
	});

	it("pins v1beta for a versionless custom base URL", async () => {
		const options = await clientOptions("https://proxy.example/google");
		expect(options).toMatchObject({ baseUrl: "https://proxy.example/google", apiVersion: "v1beta" });
	});

	it("leaves a v1 version path to a configured base URL", async () => {
		const options = await clientOptions("https://proxy.example/v1");
		expect(options).toMatchObject({ baseUrl: "https://proxy.example/v1", apiVersion: "" });
	});

	it("leaves the version path to a configured base URL", async () => {
		const options = await clientOptions("https://proxy.example/v1beta");
		expect(options).toMatchObject({ baseUrl: "https://proxy.example/v1beta", apiVersion: "" });
	});
});
