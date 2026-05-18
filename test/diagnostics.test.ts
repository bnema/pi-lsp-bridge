import test from "node:test";
import assert from "node:assert/strict";
import { buildDiagnosticsUpdateSummary } from "../src/diagnostics.js";
import type { UnifiedDiagnostic } from "../src/types.js";

function diagnostic(overrides: Partial<UnifiedDiagnostic> = {}): UnifiedDiagnostic {
	const line = overrides.range?.start.line ?? 0;
	const character = overrides.range?.start.character ?? 0;
	return {
		id: overrides.id ?? `diag-${line}-${character}`,
		providerId: overrides.providerId ?? "gopls",
		sourceKind: overrides.sourceKind ?? "lsp",
		filePath: overrides.filePath ?? "ports/mocks/mock_tmux_control_port.go",
		severity: overrides.severity ?? "hint",
		message: overrides.message ?? "interface{} can be replaced by any",
		code: overrides.code ?? "default",
		range: overrides.range ?? {
			start: { line, character },
			end: { line, character: character + 11 },
		},
		observedAt: overrides.observedAt ?? 1,
		...overrides,
	};
}

test("buildDiagnosticsUpdateSummary groups repeated similar diagnostics within one file", () => {
	const diagnostics = Array.from({ length: 10 }, (_, index) =>
		diagnostic({
			id: `interface-any-${index}`,
			range: {
				start: { line: 65 + index, character: 54 + index },
				end: { line: 65 + index, character: 65 + index },
			},
		}),
	);

	const summary = buildDiagnosticsUpdateSummary(diagnostics, 8);

	assert.ok(summary);
	assert.match(summary, /Current diagnostics for touched files: 10 hints\./u);
	assert.match(summary, /HINT: repeated 10 occurrences in ports\/mocks\/mock_tmux_control_port\.go \[default\] interface\{\} can be replaced by any/u);
	assert.match(summary, /lines: 66, 67, 68/u);
	assert.doesNotMatch(summary, /… 2 more diagnostics are available/u);
	assert.equal(summary.split("\n").filter((line) => line.startsWith("- HINT:")).length, 1);
});

test("buildDiagnosticsUpdateSummary counts omitted grouped line examples by unique line", () => {
	const diagnostics = [
		diagnostic({ id: "same-line-1", range: { start: { line: 65, character: 54 }, end: { line: 65, character: 65 } } }),
		diagnostic({ id: "same-line-2", range: { start: { line: 65, character: 74 }, end: { line: 65, character: 85 } } }),
		diagnostic({ id: "same-line-3", range: { start: { line: 65, character: 94 }, end: { line: 65, character: 105 } } }),
		diagnostic({ id: "next-line-1", range: { start: { line: 66, character: 54 }, end: { line: 66, character: 65 } } }),
		diagnostic({ id: "next-line-2", range: { start: { line: 66, character: 74 }, end: { line: 66, character: 85 } } }),
	];

	const summary = buildDiagnosticsUpdateSummary(diagnostics, 8);

	assert.ok(summary);
	assert.match(summary, /HINT: repeated 5 occurrences in ports\/mocks\/mock_tmux_control_port\.go/u);
	assert.match(summary, /\(lines: 66, 67\)/u);
	assert.doesNotMatch(summary, /lines: 66, 67, … 2 more/u);
});

test("buildDiagnosticsUpdateSummary groups exactly three same-file occurrences", () => {
	const diagnostics = Array.from({ length: 3 }, (_, index) =>
		diagnostic({
			id: `boundary-three-${index}`,
			range: {
				start: { line: 65 + index, character: 54 },
				end: { line: 65 + index, character: 65 },
			},
		}),
	);

	const summary = buildDiagnosticsUpdateSummary(diagnostics, 8);

	assert.ok(summary);
	assert.match(summary, /HINT: repeated 3 occurrences in ports\/mocks\/mock_tmux_control_port\.go/u);
	assert.equal(summary.split("\n").filter((line) => line.startsWith("- HINT:")).length, 1);
});

test("buildDiagnosticsUpdateSummary leaves two same-file occurrences ungrouped", () => {
	const diagnostics = Array.from({ length: 2 }, (_, index) =>
		diagnostic({
			id: `boundary-two-${index}`,
			range: {
				start: { line: 65 + index, character: 54 },
				end: { line: 65 + index, character: 65 },
			},
		}),
	);

	const summary = buildDiagnosticsUpdateSummary(diagnostics, 8);

	assert.ok(summary);
	assert.doesNotMatch(summary, /repeated 2 occurrences/u);
	assert.equal(summary.split("\n").filter((line) => line.startsWith("- HINT:")).length, 2);
});
