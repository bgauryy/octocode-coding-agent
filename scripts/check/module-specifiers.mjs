import { parseAst } from "rolldown/parseAst";

function bindingNames(pattern, names = []) {
	if (!pattern) return names;
	if (pattern.type === "Identifier") names.push(pattern.name);
	else if (pattern.type === "RestElement" || pattern.type === "AssignmentPattern")
		bindingNames(pattern.argument ?? pattern.left, names);
	else if (pattern.type === "TSParameterProperty") bindingNames(pattern.parameter, names);
	else if (pattern.type === "ArrayPattern") pattern.elements.forEach((element) => bindingNames(element, names));
	else if (pattern.type === "ObjectPattern")
		pattern.properties.forEach((property) => bindingNames(property.value ?? property.argument, names));
	return names;
}

function scope(parent, functionScope = false) {
	return { parent, functionScope, bindings: new Map() };
}

function nearestFunctionScope(start) {
	let current = start;
	while (current.parent && !current.functionScope) current = current.parent;
	return current;
}

function lookup(current, name) {
	for (let candidate = current; candidate; candidate = candidate.parent) {
		const binding = candidate.bindings.get(name);
		if (binding) return binding;
	}
}

function declare(current, pattern, binding = { kind: "ordinary" }) {
	for (const name of bindingNames(pattern)) current.bindings.set(name, binding);
}

function children(node, visit) {
	for (const [key, value] of Object.entries(node)) {
		if (Array.isArray(value)) {
			for (const child of value) if (child && typeof child.type === "string") visit(child, key);
		} else if (value && typeof value.type === "string") visit(value, key);
	}
}

const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const blockTypes = new Set(["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"]);

function moduleScopes(program) {
	const scopes = new WeakMap();
	function visit(node, parent) {
		let current = parent;
		const isFunction = functionTypes.has(node.type);
		if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") declare(parent, node.id);
		if (isFunction) {
			current = scope(parent);
			if (node.type === "FunctionExpression") declare(current, node.id);
			for (const parameter of node.params) declare(current, parameter);
		} else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
			current = scope(parent);
			declare(current, node.id);
		} else if (node.type === "CatchClause") {
			current = scope(parent);
			declare(current, node.param);
		} else if (node.type === "StaticBlock" || node.type === "TSModuleBlock") current = scope(parent, true);
		else if (blockTypes.has(node.type)) current = scope(parent);
		scopes.set(node, current);

		if (node.type === "VariableDeclaration") {
			const target = node.kind === "var" ? nearestFunctionScope(current) : current;
			for (const declaration of node.declarations)
				declare(target, declaration.id, {
					kind: "ordinary",
					initializer: declaration.id.type === "Identifier" ? declaration.init : undefined,
					scope: current,
				});
		} else if (node.type === "ImportDeclaration" && node.importKind !== "type") {
			const isNodeModule = node.source.value === "node:module" || node.source.value === "module";
			for (const imported of node.specifiers) {
				if (imported.importKind === "type") continue;
				const factory =
					imported.type === "ImportSpecifier" &&
					(imported.imported.name ?? imported.imported.value) === "createRequire";
				const namespace = imported.type === "ImportNamespaceSpecifier" || imported.type === "ImportDefaultSpecifier";
				declare(current, imported.local, {
					kind: isNodeModule && factory ? "create-require" : isNodeModule && namespace ? "node-module" : "ordinary",
				});
			}
		} else if (node.type === "TSImportEqualsDeclaration" && node.importKind !== "type") declare(current, node.id);
		else if (node.type === "TSEnumDeclaration" || node.type === "TSModuleDeclaration") declare(current, node.id);

		children(node, (child, key) => {
			// Parameters execute outside body var bindings; switch discriminants execute outside the case block.
			const childScope =
				isFunction && key === "body"
					? scope(current, true)
					: node.type === "SwitchStatement" && key === "discriminant"
						? parent
						: current;
			visit(child, childScope);
		});
	}
	visit(program, scope(undefined, true));
	return scopes;
}

function isFactoryCall(node, current) {
	if (node?.type !== "CallExpression") return false;
	const callee = node.callee;
	if (callee.type === "Identifier") return lookup(current, callee.name)?.kind === "create-require";
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.name === "createRequire" &&
		callee.object.type === "Identifier" &&
		lookup(current, callee.object.name)?.kind === "node-module"
	);
}

/** Return source-module strings and their source spans, including real CommonJS loaders. */
export function moduleSpecifiers(source, filename) {
	const lang = filename.endsWith(".tsx")
		? "tsx"
		: filename.endsWith(".jsx")
			? "jsx"
			: /\.d\.[cm]?ts$/.test(filename)
				? "dts"
				: /\.[cm]?ts$/.test(filename)
					? "ts"
					: "js";
	const program = parseAst(source, { lang, sourceType: "unambiguous" }, filename);
	const specifiers = [];
	const scopes = moduleScopes(program);

	const add = (node) => {
		const value =
			node?.type === "Literal" && typeof node.value === "string"
				? node.value
				: node?.type === "TemplateLiteral" && node.expressions.length === 0
					? node.quasis[0].value.cooked
					: undefined;
		if (typeof value === "string") specifiers.push({ value, start: node.start, end: node.end });
	};
	function visit(node) {
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
			case "ImportExpression":
			case "TSImportType":
				add(node.source);
				break;
			case "TSExternalModuleReference":
				add(node.expression);
				break;
			case "CallExpression":
				if (node.callee.type === "Identifier" && node.callee.name === "require") {
					const binding = lookup(scopes.get(node), "require");
					if (!binding || isFactoryCall(binding.initializer, binding.scope)) add(node.arguments[0]);
				}
		}
		children(node, visit);
	}

	visit(program);
	return specifiers.sort((left, right) => left.start - right.start);
}
