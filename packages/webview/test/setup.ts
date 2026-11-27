import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// Testing Library only auto-cleans when globals are enabled; unmount explicitly in DOM environments.
afterEach(async () => {
	if (typeof document === "undefined") return;
	const { cleanup } = await import("@testing-library/react");
	cleanup();
	// Each test owns a fresh tab; navigation within one test still retains its drafts.
	try {
		sessionStorage.clear();
	} catch {
		/* Some storage-failure tests disable it. */
	}
});
