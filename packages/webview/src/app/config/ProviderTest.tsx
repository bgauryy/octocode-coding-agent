import type {
	ProviderCredentialStatus,
	ProviderTestReport,
	ProviderTestResult,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Button } from "../ui/primitives.tsx";

/** Runs the host's test of one provider, or of every connected provider and external agent when none is named. */
export type TestProviders = (command: { provider?: string }) => Promise<ProviderTestReport>;

interface TestState {
	results: ReadonlyMap<string, ProviderTestResult>;
	/** The ids the last Test all covered; a single Test shows only under its own row. */
	all: readonly string[];
	busy: string | undefined;
	error: string | undefined;
	run: (provider?: string) => Promise<void>;
}

const TestContext = createContext<TestState | undefined>(undefined);

/** Holds the last result per provider; a test runs only when a button is pressed. */
export function ProviderTestProvider({ test, children }: { test?: TestProviders; children: ReactNode }) {
	const [results, setResults] = useState<ReadonlyMap<string, ProviderTestResult>>(new Map());
	const [all, setAll] = useState<readonly string[]>([]);
	const [busy, setBusy] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const run = useCallback(
		async (provider?: string) => {
			if (!test) return;
			setBusy(provider ?? "*");
			setError(undefined);
			try {
				const report = await test(provider ? { provider } : {});
				if (!provider) setAll(report.results.map((result) => result.id));
				setResults((current) => new Map([...current, ...report.results.map((result) => [result.id, result] as const)]));
			} catch (caught) {
				setError(errorMessage(caught));
			} finally {
				setBusy(undefined);
			}
		},
		[test],
	);
	const value = useMemo(
		() => (test ? { results, all, busy, error, run } : undefined),
		[test, results, all, busy, error, run],
	);
	return <TestContext.Provider value={value}>{children}</TestContext.Provider>;
}

const useTests = () => useContext(TestContext);

function ResultLine({ result }: { result: ProviderTestResult }) {
	return (
		<p
			className={result.status === "failed" ? "callout tone-danger" : "muted"}
			role={result.status === "failed" ? "alert" : "status"}
		>
			{result.status === "ok" ? "✓" : result.status === "failed" ? "✗" : "–"} {result.name}: {result.message}
		</p>
	);
}

/** "Test" for one connected provider, with its last result under it. */
export function RowTest({ row }: { row: ProviderCredentialStatus }) {
	const tests = useTests();
	if (!tests || !row.configured) return null;
	const result = tests.results.get(row.provider);
	return (
		<div className="config-edit">
			<Button
				size="sm"
				onClick={() => void tests.run(row.provider)}
				loading={tests.busy === row.provider}
				disabled={tests.busy !== undefined}
				aria-label={`Test ${row.name ?? row.provider}`}
			>
				Test
			</Button>
			{result && <ResultLine result={result} />}
		</div>
	);
}

/** "Test all" with a result line for every provider and external agent it covered, and the host's error if it failed. */
export function TestAll() {
	const tests = useTests();
	if (!tests) return null;
	const all = tests.all.flatMap((id) => tests.results.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
	return (
		<div className="config-edit">
			<Button
				size="sm"
				onClick={() => void tests.run()}
				loading={tests.busy === "*"}
				disabled={tests.busy !== undefined}
			>
				Test all
			</Button>
			<span className="muted"> Sends at most one small request per connected provider.</span>
			{tests.error && (
				<p className="callout tone-danger" role="alert">
					{tests.error}
				</p>
			)}
			{tests.busy === undefined && all.length > 0 && (
				<ul className="config-sources" aria-label="Test results">
					{all.map((result) => (
						<li key={`${result.kind}:${result.id}`}>
							<ResultLine result={result} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
