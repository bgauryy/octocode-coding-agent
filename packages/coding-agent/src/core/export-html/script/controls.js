// Toggle states
let thinkingExpanded = true;
let toolOutputsExpanded = false;
let showHiddenMessages = false;

function setHiddenMessagesVisible(visible) {
	showHiddenMessages = visible;
	document.body.classList.toggle("show-hidden-messages", visible);
	const button = document.querySelector('[data-action="toggle-hidden-messages"]');
	if (button) {
		button.setAttribute("aria-pressed", String(visible));
		button.textContent = visible ? "Hide hidden messages" : "Show hidden messages";
	}
}

function setThinkingExpanded(expanded) {
	thinkingExpanded = expanded;
	document.querySelector('[data-action="toggle-thinking"]')?.setAttribute("aria-pressed", String(expanded));
	document.querySelectorAll(".thinking-text").forEach((el) => {
		el.style.display = thinkingExpanded ? "" : "none";
	});
	document.querySelectorAll(".thinking-collapsed").forEach((el) => {
		el.style.display = thinkingExpanded ? "none" : "block";
	});
}

function setToolOutputsExpanded(expanded) {
	toolOutputsExpanded = expanded;
	document.querySelector('[data-action="toggle-tools"]')?.setAttribute("aria-pressed", String(expanded));
	document.querySelectorAll(".tool-output.expandable").forEach((el) => {
		el.classList.toggle("expanded", toolOutputsExpanded);
	});
	document.querySelectorAll(".compaction").forEach((el) => {
		el.classList.toggle("expanded", toolOutputsExpanded);
	});
	document.querySelectorAll(".skill-invocation").forEach((el) => {
		el.classList.toggle("expanded", toolOutputsExpanded);
	});
}

const attachHeaderHandlers = () => {
	document.querySelector('[data-action="toggle-thinking"]')?.addEventListener("click", () => {
		setThinkingExpanded(!thinkingExpanded);
	});
	document.querySelector('[data-action="toggle-tools"]')?.addEventListener("click", () => {
		setToolOutputsExpanded(!toolOutputsExpanded);
	});
	document.querySelector('[data-action="toggle-hidden-messages"]')?.addEventListener("click", () => {
		setHiddenMessagesVisible(!showHiddenMessages);
	});
};

const isEditableTarget = (element) => {
	if (!element) return false;
	const tagName = element.tagName;
	if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || tagName === "BUTTON") {
		return true;
	}
	return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"]'));
};

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		searchInput.value = "";
		searchQuery = "";
		navigateTo(leafId, "bottom");
	}

	if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(document.activeElement)) {
		return;
	}

	const key = e.key.toLowerCase();
	if (key === "t") {
		e.preventDefault();
		setThinkingExpanded(!thinkingExpanded);
	} else if (key === "o") {
		e.preventDefault();
		setToolOutputsExpanded(!toolOutputsExpanded);
	} else if (key === "h") {
		e.preventDefault();
		setHiddenMessagesVisible(!showHiddenMessages);
	}
});

// Initial render
// If URL has targetId, scroll to that specific message; otherwise stay at top
if (leafId) {
	if (urlTargetId && byId.has(urlTargetId)) {
		// Deep link: navigate to leaf and scroll to target message
		navigateTo(leafId, "target", urlTargetId);
	} else {
		navigateTo(leafId, "none");
	}
} else if (entries.length > 0) {
	// Fallback: use last entry if no leafId
	navigateTo(entries[entries.length - 1].id, "none");
}
