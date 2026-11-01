// Search input
const searchInput = document.getElementById("tree-search");
searchInput.addEventListener("input", (e) => {
	searchQuery = e.target.value;
	forceTreeRerender();
});

// Filter buttons
document.querySelectorAll(".filter-btn").forEach((btn) => {
	btn.addEventListener("click", () => {
		document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		filterMode = btn.dataset.filter;
		forceTreeRerender();
	});
});

// Sidebar toggle
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebar-overlay");
const hamburger = document.getElementById("hamburger");
const sidebarResizer = document.getElementById("sidebar-resizer");
const SIDEBAR_WIDTH_STORAGE_KEY = "pi-share:v1:sidebar-width";
const MIN_CONTENT_WIDTH = 320;

function isMobileLayout() {
	return window.matchMedia("(max-width: 900px)").matches;
}

function getSidebarBounds() {
	const rootStyles = getComputedStyle(document.documentElement);
	const minWidth = parseFloat(rootStyles.getPropertyValue("--sidebar-min-width")) || 240;
	const maxWidth = parseFloat(rootStyles.getPropertyValue("--sidebar-max-width")) || 720;
	const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
	return {
		minWidth,
		maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth)),
	};
}

function clampSidebarWidth(width) {
	const { minWidth, maxWidth } = getSidebarBounds();
	return Math.max(minWidth, Math.min(maxWidth, width));
}

function applySidebarWidth(width) {
	document.documentElement.style.setProperty("--sidebar-width", `${Math.round(clampSidebarWidth(width))}px`);
}

function loadSidebarWidth() {
	try {
		const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (raw === null) return null;
		const width = Number(raw);
		return Number.isFinite(width) ? width : null;
	} catch {
		return null;
	}
}

function saveSidebarWidth(width) {
	try {
		localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
	} catch {
		// Ignore storage failures (e.g. private browsing restrictions)
	}
}

function setupSidebarResize() {
	const savedWidth = loadSidebarWidth();
	if (savedWidth !== null) {
		applySidebarWidth(savedWidth);
	}

	if (!sidebarResizer) return;

	let cleanupDrag = null;

	const stopDrag = (pointerId) => {
		if (cleanupDrag) {
			cleanupDrag(pointerId);
			cleanupDrag = null;
		}
	};

	sidebarResizer.addEventListener("pointerdown", (e) => {
		if (isMobileLayout()) return;

		e.preventDefault();
		const startX = e.clientX;
		const startWidth = sidebar.getBoundingClientRect().width;
		document.body.classList.add("sidebar-resizing");
		sidebarResizer.setPointerCapture?.(e.pointerId);

		const onPointerMove = (event) => {
			applySidebarWidth(startWidth + (event.clientX - startX));
		};

		cleanupDrag = (pointerIdToRelease) => {
			document.body.classList.remove("sidebar-resizing");
			sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			saveSidebarWidth(sidebar.getBoundingClientRect().width);
		};

		const onPointerUp = (event) => stopDrag(event.pointerId);
		const onPointerCancel = (event) => stopDrag(event.pointerId);

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
	});

	sidebarResizer.addEventListener("dblclick", () => {
		if (isMobileLayout()) return;
		applySidebarWidth(400);
		saveSidebarWidth(400);
	});

	window.addEventListener("resize", () => {
		if (isMobileLayout()) return;
		applySidebarWidth(sidebar.getBoundingClientRect().width);
	});
}

setupSidebarResize();

hamburger.addEventListener("click", () => {
	sidebar.classList.add("open");
	overlay.classList.add("open");
	hamburger.style.display = "none";
});

const closeSidebar = () => {
	sidebar.classList.remove("open");
	overlay.classList.remove("open");
	hamburger.style.display = "";
};

overlay.addEventListener("click", closeSidebar);
document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
