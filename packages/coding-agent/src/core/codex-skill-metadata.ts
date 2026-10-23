import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

interface CodexSkillPolicy {
	allowImplicitInvocation?: boolean;
	products: ("chatgpt" | "codex" | "atlas")[];
}
interface CodexSkillMetadata {
	policy?: CodexSkillPolicy;
	interfaceDeclared: boolean;
	dependenciesDeclared: boolean;
}

/** Validate optional Codex sidecar fields before consuming policy. No dependency is activated. */
export function parseCodexSkillMetadata(source: string): CodexSkillMetadata {
	const document = parseDocument(source, { uniqueKeys: false });
	const fail = (): never => {
		throw new Error("Invalid Codex skill metadata");
	};
	if (document.errors.length) fail();
	function resolve(node: unknown, seen = new Set<unknown>()): unknown {
		if (!isAlias(node)) return node;
		if (seen.has(node)) return fail();
		seen.add(node);
		const target = node.resolve(document);
		if (!target) return fail();
		return resolve(target, seen);
	}
	function checkAliases(
		node: unknown,
		active = new Set<unknown>(),
		depth = 0,
	): void {
		if (depth > 128 || active.has(node)) fail();
		if (!node || typeof node !== "object") return;
		active.add(node);
		if (isAlias(node)) {
			if (!node.resolve(document)) fail();
		} else if (isMap(node))
			for (const pair of node.items) {
				checkAliases(pair.key, active, depth + 1);
				checkAliases(pair.value, active, depth + 1);
			}
		else if (isSeq(node))
			for (const item of node.items) checkAliases(item, active, depth + 1);
		active.delete(node);
	}
	checkAliases(document.contents);
	function blank(node: unknown): boolean {
		return (
			node == null ||
			(isScalar(node) && node.type === "PLAIN" && node.source === "")
		);
	}
	function optional(node: unknown): boolean {
		node = resolve(node);
		if (node == null) return true;
		if (!isScalar(node) || node.type !== "PLAIN") return false;
		if (node.tag && node.tag !== "tag:yaml.org,2002:null") return false;
		const nul = ["", "~", "null", "Null", "NULL"].includes(node.source ?? "");
		if (node.tag && !nul) fail();
		return nul;
	}
	function fields(
		raw: unknown,
		known: readonly string[],
		aliases: Record<string, string> = {},
	): Map<string, unknown> {
		const node = resolve(raw);
		if (blank(node)) return new Map();
		if (!isMap(node)) return fail();
		const result = new Map<string, unknown>();
		for (const pair of node.items) {
			const keyNode = resolve(pair.key);
			if (!isScalar(keyNode)) return fail();
			const key = String(keyNode.source ?? keyNode.value ?? "");
			const name = aliases[key] ?? key;
			if (!known.includes(name)) continue;
			if (result.has(name)) fail();
			result.set(name, resolve(pair.value));
		}
		return result;
	}
	function scalar(raw: unknown): void {
		const node = resolve(raw);
		if (optional(node)) return;
		if (!isScalar(node)) fail();
	}
	function sequence(raw: unknown): unknown[] {
		const node = resolve(raw);
		if (blank(node)) return [];
		if (!isSeq(node)) return fail();
		return node.items;
	}
	const root = fields(document.contents, [
		"policy",
		"interface",
		"dependencies",
	]);
	let policy: CodexSkillPolicy | undefined;
	const policyNode = root.get("policy");
	if (!optional(policyNode)) {
		const p = fields(policyNode, ["allow_implicit_invocation", "products"]);
		const implicit = p.get("allow_implicit_invocation");
		let allow: boolean | undefined;
		if (!optional(implicit)) {
			if (
				!isScalar(implicit) ||
				implicit.type !== "PLAIN" ||
				!["true", "True", "TRUE", "false", "False", "FALSE"].includes(
					implicit.source ?? "",
				)
			)
				fail();
			allow = (implicit as { source: string }).source.toLowerCase() === "true";
		}
		const products = sequence(p.get("products")).map((raw) => {
			const node = resolve(raw);
			if (
				!isScalar(node) ||
				(node.tag && !node.tag.startsWith("tag:yaml.org,2002:"))
			)
				return fail();
			const value = node.source ?? String(node.value);
			if (
				!["chatgpt", "codex", "atlas", "CHATGPT", "CODEX", "ATLAS"].includes(
					value,
				)
			)
				return fail();
			return value.toLowerCase() as CodexSkillPolicy["products"][number];
		});
		policy = {
			...(allow === undefined ? {} : { allowImplicitInvocation: allow }),
			products,
		};
	}
	const interfaceNode = root.get("interface");
	const interfaceDeclared = !optional(interfaceNode);
	if (interfaceDeclared) {
		for (const value of fields(interfaceNode, [
			"display_name",
			"short_description",
			"icon_small",
			"icon_large",
			"brand_color",
			"default_prompt",
		]).values())
			scalar(value);
	}
	const dependenciesNode = root.get("dependencies");
	const dependenciesDeclared = !optional(dependenciesNode);
	if (dependenciesDeclared) {
		const deps = fields(dependenciesNode, ["tools"]);
		for (const tool of sequence(deps.get("tools"))) {
			const values = fields(tool, [
				"type",
				"value",
				"description",
				"transport",
				"command",
				"url",
				"oauth",
			]);
			for (const key of [
				"type",
				"value",
				"description",
				"transport",
				"command",
				"url",
			])
				scalar(values.get(key));
			const oauth = values.get("oauth");
			if (optional(oauth)) continue;
			const port = fields(oauth, ["callbackPort"], {
				callback_port: "callbackPort",
			}).get("callbackPort");
			if (optional(port)) continue;
			if (!isScalar(port) || port.type !== "PLAIN") fail();
			const source = (port as { source?: string }).source ?? "";
			if (
				!/^\+?(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(source)
			)
				fail();
			const numeric = Number(source.replace(/^\+/, ""));
			if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) fail();
		}
	}
	return { policy, interfaceDeclared, dependenciesDeclared };
}
