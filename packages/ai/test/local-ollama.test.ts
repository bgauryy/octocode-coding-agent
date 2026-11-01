import { describe, expect, it } from "vitest";
import { localOllamaEnabled, OLLAMA_MODEL } from "./local-ollama.ts";

const LISTED = `NAME            ID              SIZE      MODIFIED\n${OLLAMA_MODEL}     aa4295ac10c3    13 GB     2 days ago\n`;

describe("local Ollama test gate", () => {
	it("stays off without OCTOCODE_LOCAL_LLM=1, without asking ollama anything", () => {
		let asked = false;
		const list = () => {
			asked = true;
			return LISTED;
		};
		expect(localOllamaEnabled({}, list)).toBe(false);
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "0" }, list)).toBe(false);
		expect(asked).toBe(false);
	});

	it("lets OCTOCODE_NO_LOCAL_LLM veto an opt-in", () => {
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "1", OCTOCODE_NO_LOCAL_LLM: "1" }, () => LISTED)).toBe(false);
	});

	it("runs only when the model is already installed", () => {
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "1" }, () => LISTED)).toBe(true);
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "1" }, () => "NAME ID SIZE MODIFIED\nllama3:8b x 4 GB now\n")).toBe(
			false,
		);
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "1" }, () => `${OLLAMA_MODEL}-extra x 1 GB now\n`)).toBe(false);
	});

	it("stays off when ollama is missing or fails", () => {
		const missing = () => {
			throw Object.assign(new Error("spawn ollama ENOENT"), { code: "ENOENT" });
		};
		expect(localOllamaEnabled({ OCTOCODE_LOCAL_LLM: "1" }, missing)).toBe(false);
	});
});
