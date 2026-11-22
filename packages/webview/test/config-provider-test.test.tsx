/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigSnapshot,
	type ProviderTestReport,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);

const provider = (id: string, name: string, configured: boolean) => ({
	provider: id,
	name,
	configured,
	sources: configured ? [{ kind: "keychain" as const }] : [],
	models: [],
});
const snapshot: ConfigSnapshot = {
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 22),
	keychainAvailable: true,
	providers: [provider("mantle", "Mantle", true), provider("idle", "Idle host", false)],
	settings: [],
	writable: true,
};
const result = (
	id: string,
	name: string,
	status: "ok" | "failed",
	message: string,
	kind: "provider" | "runner" = "provider",
) => ({ id, name, kind, status, via: "check", message, at: 1 }) as const;

describe("provider Test and Test all", () => {
	it("tests one connected provider only when pressed and shows the error text", async () => {
		const testProviders = vi.fn(async (): Promise<ProviderTestReport> => ({
			results: [
				result("mantle", "Mantle", "failed", "404 model moonshotai.kimi-k3.1 not found (nearest served: zai.glm-4.7)"),
			],
		}));
		render(<ConfigView load={async () => snapshot} testProviders={testProviders} />);
		await screen.findByRole("button", { name: "Test Mantle" });
		expect(testProviders).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Test Idle host" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Test Mantle" }));
		expect(testProviders).toHaveBeenCalledWith({ provider: "mantle" });
		expect(await screen.findByText(/nearest served: zai\.glm-4\.7/)).toBeInTheDocument();
	});

	it("Test all lists a result per provider and external agent", async () => {
		const testProviders = vi.fn(async (): Promise<ProviderTestReport> => ({
			results: [
				result("mantle", "Mantle", "ok", "✓ credential worked"),
				result("claude-code", "Claude Code", "failed", "signed out", "runner"),
			],
		}));
		render(<ConfigView load={async () => snapshot} testProviders={testProviders} />);
		await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
		expect(testProviders).toHaveBeenCalledWith({});
		const list = await screen.findByRole("list", { name: "Test results" });
		expect(list).toHaveTextContent("Claude Code: signed out");
		expect(list).toHaveTextContent("Mantle: ✓ credential worked");
	});

	it("offers no Test without a host that can test", async () => {
		render(<ConfigView load={async () => snapshot} />);
		await screen.findByRole("heading", { name: "Provider credentials" });
		expect(screen.queryByRole("button", { name: /^Test/ })).toBeNull();
	});
});
