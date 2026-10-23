import { parse as parseToml } from "smol-toml";

/** Parse a settings document without including potentially secret source text in TOML errors. */
export function parseConfigDocument(text: string, file: string): unknown {
	if (!file.endsWith(".toml")) return JSON.parse(text);
	try { return parseToml(text); }
	catch { throw new Error("Invalid TOML configuration"); }
}
