import { useEffect, useRef, useState } from "react";
import { NoticeTracker, shouldNotify } from "../model/notifications.ts";
import { BellIcon } from "../ui/icons.tsx";
import { Button } from "../ui/primitives.tsx";
import { playChime, prepareChime } from "./chime.ts";
import {
	onNotificationOpen,
	permissionState,
	type PermissionState,
	registerWorker,
	requestPermission,
	showNotice,
} from "./notify.ts";
import { useLive } from "./session.tsx";
import { readWebPrefs, writeWebPrefs } from "./web-prefs.ts";

const PERMISSION_LABEL: Record<Exclude<PermissionState, "granted">, string> = {
	default: "Enable notifications",
	denied: "Notifications blocked",
	unsupported: "Notifications unavailable",
};
const PERMISSION_HINT: Record<Exclude<PermissionState, "granted">, string> = {
	default: "Get an OS notification when an approval or question waits, or a run finishes or fails.",
	denied: "This window blocked notifications. Allow them in the browser's site settings for this address.",
	unsupported: "This browser cannot show notifications here.",
};

/**
 * The header's notification control and the engine behind it. Permission is asked only from the button (a user gesture),
 * never on load. Once granted, the page registers the service worker, raises one notice per event while the window is
 * out of focus, and plays a chime when the host-stored sound preference is on.
 */
export function Notifications() {
	const live = useLive();
	const [permission, setPermission] = useState<PermissionState>(permissionState);
	const [sound, setSound] = useState<boolean | undefined>();
	const [problem, setProblem] = useState<string | undefined>();
	const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
	const soundRef = useRef(false);
	useEffect(() => {
		soundRef.current = sound === true;
	}, [sound]);
	const granted = permission === "granted";

	useEffect(() => {
		if (!granted) return;
		let current = true;
		registerWorker().then(
			(value) => {
				if (current) registration.current = value;
			},
			(error: unknown) => current && setProblem(`Notifications could not start: ${String(error)}`),
		);
		readWebPrefs(live.access).then(
			(prefs) => current && setSound(prefs.sound),
			(error: unknown) => current && setProblem(`Could not read the sound setting: ${String(error)}`),
		);
		const stopOpen = onNotificationOpen();
		return () => {
			current = false;
			stopOpen();
		};
	}, [granted, live.access]);

	// The tracker watches from the start, so permission granted later does not replay what already happened.
	useEffect(() => {
		const tracker = new NoticeTracker();
		const check = () => {
			const notices = tracker.observe(
				live.session.getState().application,
				live.workspace.getState().snapshot ?? undefined,
			);
			const worker = registration.current;
			if (!worker || permissionState() !== "granted" || !shouldNotify(document)) return;
			for (const notice of notices)
				showNotice(worker, notice).catch((error: unknown) => setProblem(`Notification failed: ${String(error)}`));
			if (notices.length && soundRef.current) playChime();
		};
		check();
		const stops = [live.session.subscribe(check), live.workspace.subscribe(check)];
		return () => stops.forEach((stop) => stop());
	}, [live]);

	const enable = () => {
		prepareChime();
		setProblem(undefined);
		requestPermission().then(setPermission, (error: unknown) =>
			setProblem(`Permission request failed: ${String(error)}`),
		);
	};
	const toggleSound = () => {
		prepareChime();
		const next = !soundRef.current;
		setProblem(undefined);
		writeWebPrefs(live.access, { sound: next }).then(
			(prefs) => {
				setSound(prefs.sound);
				if (prefs.sound) playChime();
			},
			(error: unknown) => setProblem(`Could not save the sound setting: ${String(error)}`),
		);
	};

	return (
		<div className="notify-control">
			{granted ? (
				<>
					<span className="notify-state">
						<BellIcon /> Notifications on
					</span>
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={sound === true}
						disabled={sound === undefined}
						onClick={toggleSound}
						title="Play a chime with each notification. Off by default."
					>
						Sound {sound ? "on" : "off"}
					</Button>
				</>
			) : (
				<Button
					size="sm"
					variant="ghost"
					icon={<BellIcon />}
					disabled={permission !== "default"}
					onClick={enable}
					title={PERMISSION_HINT[permission]}
				>
					{PERMISSION_LABEL[permission]}
				</Button>
			)}
			{problem && (
				<span className="notify-problem" role="alert">
					{problem}
				</span>
			)}
		</div>
	);
}
