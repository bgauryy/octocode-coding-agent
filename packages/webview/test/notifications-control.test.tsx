/** @vitest-environment jsdom */
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Notifications } from "../src/app/live/Notifications.tsx";
import { SERVICE_WORKER_ROUTE, WEB_PREFS_ROUTE } from "../src/index.ts";
import { controlView, fetchControl, setupControls } from "./control-fixtures.tsx";

const showNotification = vi.fn(async () => undefined);
const register = vi.fn(async () => ({ showNotification }));
let permission: NotificationPermission;
const requestPermission = vi.fn(async () => {
	permission = "granted";
	return permission;
});
let stored = false;

function stubBrowser(initial: NotificationPermission | "unsupported") {
	if (initial === "unsupported") return;
	permission = initial;
	const notification = Object.assign(function Notification() {}, { requestPermission });
	Object.defineProperty(notification, "permission", { get: () => permission });
	vi.stubGlobal("Notification", notification);
	Object.defineProperty(navigator, "serviceWorker", {
		value: { register, addEventListener: vi.fn(), removeEventListener: vi.fn() },
		configurable: true,
	});
}

beforeEach(() => {
	setupControls();
	stored = false;
	showNotification.mockClear();
	register.mockClear();
	requestPermission.mockClear();
	fetchControl.mockImplementation(async (url, init) => {
		if (url !== WEB_PREFS_ROUTE) return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
		if (init?.method === "POST") stored = JSON.parse(String(init.body)).sound;
		return new Response(JSON.stringify({ sound: stored }));
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "serviceWorker");
});

it("says so when the browser cannot show notifications, and asks for nothing", () => {
	stubBrowser("unsupported");
	controlView(<Notifications />);
	expect(screen.getByRole("button", { name: "Notifications unavailable" })).toBeDisabled();
	expect(fetchControl).not.toHaveBeenCalled();
});

it("shows blocked when permission was denied", () => {
	stubBrowser("denied");
	controlView(<Notifications />);
	expect(screen.getByRole("button", { name: "Notifications blocked" })).toBeDisabled();
	expect(requestPermission).not.toHaveBeenCalled();
});

it("asks for permission only when the button is clicked, then registers the worker and loads the sound setting", async () => {
	stubBrowser("default");
	controlView(<Notifications />);
	expect(requestPermission).not.toHaveBeenCalled();
	expect(fetchControl).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
	expect(requestPermission).toHaveBeenCalledTimes(1);
	await screen.findByText(/Notifications on/);
	await waitFor(() => expect(register).toHaveBeenCalledWith(SERVICE_WORKER_ROUTE, { scope: "/" }));
	const sound = await screen.findByRole("button", { name: "Sound off" });
	await waitFor(() => expect(sound).toBeEnabled());
});

it("saves the sound toggle on the host, off until switched on", async () => {
	stubBrowser("granted");
	controlView(<Notifications />);
	const sound = await screen.findByRole("button", { name: "Sound off" });
	await waitFor(() => expect(sound).toBeEnabled());
	await userEvent.click(sound);
	await screen.findByRole("button", { name: "Sound on" });
	expect(stored).toBe(true);
});

it("notifies once for a waiting approval while the window is not focused, and not while it is", async () => {
	stubBrowser("granted");
	const view = controlView(<Notifications />);
	await waitFor(() => expect(register).toHaveBeenCalled());
	await act(() => Promise.resolve());
	const awaiting = { kind: "approval" as const, id: "d1", title: "Run rm?" };
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	await view.session({ awaiting });
	expect(showNotification).not.toHaveBeenCalled();

	vi.spyOn(document, "hasFocus").mockReturnValue(false);
	await view.session({ awaiting: { ...awaiting, id: "d2" } });
	await view.session({ awaiting: { ...awaiting, id: "d2" } });
	expect(showNotification).toHaveBeenCalledTimes(1);
	expect(showNotification).toHaveBeenCalledWith(
		"Approval needed",
		expect.objectContaining({
			body: "Run rm?",
			tag: expect.stringContaining("d2"),
			data: { search: "", hash: "#activity" },
		}),
	);
});
