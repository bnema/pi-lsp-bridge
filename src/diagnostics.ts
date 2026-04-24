import type { DiagnosticsCounts, UnifiedDiagnostic } from "./types.js";
import { clipText, compactWhitespace, stableDiagnosticId } from "./util.js";

function emptyCounts(): DiagnosticsCounts {
	return { error: 0, warning: 0, info: 0, hint: 0 };
}

function sortDiagnostics(diagnostics: UnifiedDiagnostic[]): UnifiedDiagnostic[] {
	const severityRank = new Map<UnifiedDiagnostic["severity"], number>([
		["error", 0],
		["warning", 1],
		["info", 2],
		["hint", 3],
	]);
	return [...diagnostics].sort((left, right) => {
		const severityDiff = (severityRank.get(left.severity) ?? 99) - (severityRank.get(right.severity) ?? 99);
		if (severityDiff !== 0) return severityDiff;
		if (left.filePath !== right.filePath) return left.filePath.localeCompare(right.filePath);
		const leftLine = left.range?.start.line ?? 0;
		const rightLine = right.range?.start.line ?? 0;
		if (leftLine !== rightLine) return leftLine - rightLine;
		return left.message.localeCompare(right.message);
	});
}

function countDiagnostics(diagnostics: UnifiedDiagnostic[]): DiagnosticsCounts {
	const counts = emptyCounts();
	for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
	return counts;
}

const REPEATED_DIAGNOSTIC_MIN_FILES = 2;
const SUMMARY_EXAMPLE_FILE_LIMIT = 3;

type DiagnosticSummaryEntry =
	| { kind: "single"; diagnostic: UnifiedDiagnostic }
	| { kind: "group"; representative: UnifiedDiagnostic; diagnostics: UnifiedDiagnostic[]; filePaths: string[] };

export function diagnosticIssueKey(diagnostic: UnifiedDiagnostic): string {
	return stableDiagnosticId([
		diagnostic.providerId,
		diagnostic.sourceKind,
		diagnostic.severity,
		diagnostic.code,
		compactWhitespace(diagnostic.message),
	]);
}

function uniqueFilePaths(diagnostics: UnifiedDiagnostic[]): string[] {
	return Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.filePath))).sort((left, right) => left.localeCompare(right));
}

function buildSummaryEntries(diagnostics: UnifiedDiagnostic[]): DiagnosticSummaryEntry[] {
	const sorted = sortDiagnostics(diagnostics);
	const buckets = new Map<string, UnifiedDiagnostic[]>();
	for (const diagnostic of sorted) {
		const key = diagnosticIssueKey(diagnostic);
		const bucket = buckets.get(key) ?? [];
		bucket.push(diagnostic);
		buckets.set(key, bucket);
	}

	const emittedGroups = new Set<string>();
	const entries: DiagnosticSummaryEntry[] = [];
	for (const diagnostic of sorted) {
		const key = diagnosticIssueKey(diagnostic);
		const bucket = buckets.get(key) ?? [diagnostic];
		const filePaths = uniqueFilePaths(bucket);
		if (filePaths.length >= REPEATED_DIAGNOSTIC_MIN_FILES) {
			if (emittedGroups.has(key)) continue;
			emittedGroups.add(key);
			entries.push({ kind: "group", representative: bucket[0] ?? diagnostic, diagnostics: bucket, filePaths });
			continue;
		}
		entries.push({ kind: "single", diagnostic });
	}
	return entries;
}

function countDiagnosticsInEntries(entries: DiagnosticSummaryEntry[]): number {
	return entries.reduce((count, entry) => count + (entry.kind === "group" ? entry.diagnostics.length : 1), 0);
}

function formatDiagnosticGroup(entry: Extract<DiagnosticSummaryEntry, { kind: "group" }>): string {
	const code = entry.representative.code ? ` [${entry.representative.code}]` : "";
	const occurrences =
		entry.diagnostics.length === entry.filePaths.length
			? `${entry.filePaths.length} files`
			: `${entry.diagnostics.length} occurrences across ${entry.filePaths.length} files`;
	const exampleFiles = entry.filePaths.slice(0, SUMMARY_EXAMPLE_FILE_LIMIT);
	const moreExamples = entry.filePaths.length > SUMMARY_EXAMPLE_FILE_LIMIT ? `, … ${entry.filePaths.length - SUMMARY_EXAMPLE_FILE_LIMIT} more` : "";
	const examples = exampleFiles.length > 0 ? ` (examples: ${exampleFiles.join(", ")}${moreExamples})` : "";
	return `${entry.representative.severity.toUpperCase()}: repeated in ${occurrences}${code} ${clipText(
		compactWhitespace(entry.representative.message),
		220,
	)}${examples}`;
}

function formatSummaryEntry(entry: DiagnosticSummaryEntry): string {
	return entry.kind === "group" ? formatDiagnosticGroup(entry) : formatDiagnosticLine(entry.diagnostic);
}

function mergeDuplicates(diagnostics: UnifiedDiagnostic[]): UnifiedDiagnostic[] {
	const merged = new Map<string, UnifiedDiagnostic>();
	for (const diagnostic of diagnostics) {
		const key = stableDiagnosticId([
			diagnostic.filePath,
			diagnostic.severity,
			diagnostic.code,
			diagnostic.range?.start.line,
			diagnostic.range?.start.character,
			compactWhitespace(diagnostic.message),
		]);
		if (!merged.has(key)) {
			merged.set(key, { ...diagnostic, id: key });
			continue;
		}
		const current = merged.get(key)!;
		if (diagnostic.observedAt > current.observedAt) {
			merged.set(key, { ...diagnostic, id: key });
		}
	}
	return sortDiagnostics(Array.from(merged.values()));
}

export class DiagnosticsStore {
	private providerFileMap = new Map<string, Map<string, UnifiedDiagnostic[]>>();
	private version = 0;
	private lastChangedAt = Date.now();

	replaceProviderFiles(providerId: string, updates: Map<string, UnifiedDiagnostic[]>): void {
		const current = this.providerFileMap.get(providerId) ?? new Map<string, UnifiedDiagnostic[]>();
		for (const [filePath, diagnostics] of updates) {
			current.set(filePath, diagnostics);
		}
		this.providerFileMap.set(providerId, current);
		this.version += 1;
		this.lastChangedAt = Date.now();
	}

	replaceProviderSnapshot(providerId: string, diagnostics: UnifiedDiagnostic[]): void {
		const byFile = new Map<string, UnifiedDiagnostic[]>();
		for (const diagnostic of diagnostics) {
			const bucket = byFile.get(diagnostic.filePath) ?? [];
			bucket.push(diagnostic);
			byFile.set(diagnostic.filePath, bucket);
		}
		this.providerFileMap.set(providerId, byFile);
		this.version += 1;
		this.lastChangedAt = Date.now();
	}

	clearProvider(providerId: string): void {
		if (!this.providerFileMap.delete(providerId)) return;
		this.version += 1;
		this.lastChangedAt = Date.now();
	}

	getAll(): UnifiedDiagnostic[] {
		const all: UnifiedDiagnostic[] = [];
		for (const fileMap of this.providerFileMap.values()) {
			for (const diagnostics of fileMap.values()) all.push(...diagnostics);
		}
		return mergeDuplicates(all);
	}

	getByFile(filePath: string): UnifiedDiagnostic[] {
		const all: UnifiedDiagnostic[] = [];
		for (const fileMap of this.providerFileMap.values()) {
			all.push(...(fileMap.get(filePath) ?? []));
		}
		return mergeDuplicates(all);
	}

	getByProvider(providerId: string): UnifiedDiagnostic[] {
		const all: UnifiedDiagnostic[] = [];
		for (const diagnostics of this.providerFileMap.get(providerId)?.values() ?? []) all.push(...diagnostics);
		return mergeDuplicates(all);
	}

	getCounts(diagnostics: UnifiedDiagnostic[] = this.getAll()): DiagnosticsCounts {
		return countDiagnostics(diagnostics);
	}

	getVersion(): number {
		return this.version;
	}

	getLastChangedAt(): number {
		return this.lastChangedAt;
	}
}

export function formatCounts(counts: DiagnosticsCounts): string {
	const parts: string[] = [];
	if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
	if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
	if (counts.info) parts.push(`${counts.info} info`);
	if (counts.hint) parts.push(`${counts.hint} hint${counts.hint === 1 ? "" : "s"}`);
	return parts.length > 0 ? parts.join(", ") : "no diagnostics";
}

export function formatStatusCounts(counts: DiagnosticsCounts): string | null {
	const parts: string[] = [];
	if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
	if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? "" : "s"}`);
	return parts.length > 0 ? parts.join(", ") : null;
}

export function formatDiagnosticLine(diagnostic: UnifiedDiagnostic): string {
	const line = (diagnostic.range?.start.line ?? 0) + 1;
	const column = (diagnostic.range?.start.character ?? 0) + 1;
	const location = diagnostic.range ? `:${line}:${column}` : "";
	const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
	return `${diagnostic.severity.toUpperCase()}: ${diagnostic.filePath}${location}${code} ${clipText(compactWhitespace(diagnostic.message), 220)}`;
}

export function buildFileSummary(filePath: string, diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCounts(countDiagnostics(diagnostics));
	const entries = buildSummaryEntries(diagnostics);
	const lines = [`Diagnostics for ${filePath}: ${counts}`];
	for (const entry of entries.slice(0, maxItems)) lines.push(`- ${formatSummaryEntry(entry)}`);
	const remainingCount = countDiagnosticsInEntries(entries.slice(maxItems));
	if (remainingCount > 0) lines.push(`- … ${remainingCount} more`);
	return lines.join("\n");
}

export function buildDiagnosticsUpdateSummary(diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCounts(countDiagnostics(diagnostics));
	const entries = buildSummaryEntries(diagnostics);
	const lines = [`Current diagnostics for touched files: ${counts}.`];
	for (const entry of entries.slice(0, maxItems)) lines.push(`- ${formatSummaryEntry(entry)}`);
	const remainingCount = countDiagnosticsInEntries(entries.slice(maxItems));
	if (remainingCount > 0) lines.push(`- … ${remainingCount} more diagnostics are available via the diagnostics tool.`);
	return lines.join("\n");
}

export function buildPromptSummary(diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCounts(countDiagnostics(diagnostics));
	const entries = buildSummaryEntries(diagnostics);
	const lines = [
		"Background diagnostics snapshot:",
		`Current merged diagnostics: ${counts}.`,
		"Most relevant current issues:",
	];
	for (const entry of entries.slice(0, maxItems)) lines.push(`- ${formatSummaryEntry(entry)}`);
	const remainingCount = countDiagnosticsInEntries(entries.slice(maxItems));
	if (remainingCount > 0) lines.push(`- … ${remainingCount} more diagnostics are available via the diagnostics tool.`);
	return lines.join("\n");
}
