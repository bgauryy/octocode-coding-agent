// TREE DISPLAY TEXT (pure data -> string)
// ============================================================

function formatToolCall(name, args) {
	switch (name) {
		case "bash": {
			const rawCmd = String(args.command || "");
			const cmd = rawCmd
				.replace(/[\n\t]/g, " ")
				.trim()
				.slice(0, 50);
			return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
		}
		default: {
			const argsStr = JSON.stringify(args).slice(0, 40);
			return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
		}
	}
}

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function sanitizeMarkdownUrl(value) {
	const href = String(value || "")
		.trim()
		.replace(/[\x00-\x1f\x7f]/g, "");
	if (!href) return href;

	const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
	if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) {
		return null;
	}

	return href;
}

/**
 * Truncate string to maxLen chars, append "..." if truncated.
 */
function truncate(s, maxLen = 100) {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen) + "...";
}

/**
 * Get display text for tree node (returns HTML string).
 */
function getTreeNodeDisplayHtml(entry, label) {
	const normalize = (s) => s.replace(/[\n\t]/g, " ").trim();
	const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : "";

	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (msg.role === "user") {
				const rawContent = extractContent(msg.content);
				const skillBlock = parseSkillBlock(rawContent);
				if (skillBlock) {
					let treeHtml = labelHtml + `<span class="tree-role-skill">skill:</span> ${escapeHtml(skillBlock.name)}`;
					if (skillBlock.userMessage) {
						treeHtml += ` · <span class="tree-role-user">user:</span> ${escapeHtml(truncate(normalize(skillBlock.userMessage)))}`;
					}
					return treeHtml;
				}
				const content = truncate(normalize(rawContent));
				return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
			}
			if (msg.role === "assistant") {
				const textContent = truncate(normalize(extractContent(msg.content)));
				if (textContent) {
					return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
				}
				if (msg.stopReason === "aborted") {
					return (
						labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`
					);
				}
				if (msg.errorMessage) {
					return (
						labelHtml +
						`<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`
					);
				}
				return (
					labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`
				);
			}
			if (msg.role === "toolResult") {
				const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
				if (toolCall) {
					return (
						labelHtml +
						`<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`
					);
				}
				return labelHtml + `<span class="tree-role-tool">[${escapeHtml(msg.toolName || "tool")}]</span>`;
			}
			if (msg.role === "bashExecution") {
				const cmd = truncate(normalize(msg.command || ""));
				return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
			}
			return labelHtml + `<span class="tree-muted">[${escapeHtml(msg.role)}]</span>`;
		}
		case "compaction":
			return (
				labelHtml +
				`<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]</span>`
			);
		case "branch_summary": {
			const summary = truncate(normalize(entry.summary || ""));
			return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
		}
		case "custom_message": {
			const content = typeof entry.content === "string" ? entry.content : extractContent(entry.content);
			return (
				labelHtml +
				`<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`
			);
		}
		case "model_change":
			return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.modelId)}]</span>`;
		case "thinking_level_change":
			return labelHtml + `<span class="tree-muted">[thinking: ${escapeHtml(entry.thinkingLevel)}]</span>`;
		case "context_edit":
			return (
				labelHtml +
				`<span class="tree-muted">[context ${entry.replacement === null ? "omit" : "replace"}: ${escapeHtml(entry.targetId)}]</span>`
			);
		default:
			return labelHtml + `<span class="tree-muted">[${escapeHtml(entry.type)}]</span>`;
	}
}

// TREE RENDERING (DOM manipulation)
// ============================================================

let currentLeafId = leafId;
let currentTargetId = urlTargetId || leafId;
let treeRendered = false;

function renderTree() {
	const tree = buildTree();
	const activePathIds = buildActivePathIds(currentLeafId);
	const flatNodes = flattenTree(tree, activePathIds);
	const filtered = filterNodes(flatNodes, currentLeafId);
	const container = document.getElementById("tree-container");

	// Full render only on first call or when filter/search changes
	if (!treeRendered) {
		container.innerHTML = "";

		for (const flatNode of filtered) {
			const entry = flatNode.node.entry;
			const isOnPath = activePathIds.has(entry.id);
			const isTarget = entry.id === currentTargetId;

			const div = document.createElement("div");
			div.className = "tree-node";
			if (isOnPath) div.classList.add("in-path");
			if (isTarget) div.classList.add("active");
			div.dataset.id = entry.id;

			const prefix = buildTreePrefix(flatNode);
			const prefixSpan = document.createElement("span");
			prefixSpan.className = "tree-prefix";
			prefixSpan.textContent = prefix;

			const marker = document.createElement("span");
			marker.className = "tree-marker";
			marker.textContent = isOnPath ? "•" : " ";

			const content = document.createElement("span");
			content.className = "tree-content";
			content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

			div.appendChild(prefixSpan);
			div.appendChild(marker);
			div.appendChild(content);
			// Navigate to the newest leaf through this node, but scroll to the clicked node
			div.addEventListener("click", () => {
				if (window.getSelection().toString()) return;
				const leafId = findNewestLeaf(entry.id);
				navigateTo(leafId, "target", entry.id);
			});

			container.appendChild(div);
		}

		treeRendered = true;
	} else {
		// Just update markers and classes
		const nodes = container.querySelectorAll(".tree-node");
		for (const node of nodes) {
			const id = node.dataset.id;
			const isOnPath = activePathIds.has(id);
			const isTarget = id === currentTargetId;

			node.classList.toggle("in-path", isOnPath);
			node.classList.toggle("active", isTarget);

			const marker = node.querySelector(".tree-marker");
			if (marker) {
				marker.textContent = isOnPath ? "•" : " ";
			}
		}
	}

	document.getElementById("tree-status").textContent = `${filtered.length} / ${flatNodes.length} entries`;

	// Scroll active node into view after layout
	setTimeout(() => {
		const activeNode = container.querySelector(".tree-node.active");
		if (activeNode) {
			activeNode.scrollIntoView({ block: "nearest" });
		}
	}, 0);
}

function forceTreeRerender() {
	treeRendered = false;
	renderTree();
}
