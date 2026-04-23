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
	const lines = [`Diagnostics for ${filePath}: ${counts}`];
	for (const diagnostic of diagnostics.slice(0, maxItems)) lines.push(`- ${formatDiagnosticLine(diagnostic)}`);
	if (diagnostics.length > maxItems) lines.push(`- … ${diagnostics.length - maxItems} more`);
	return lines.join("\n");
}

export function buildPromptSummary(diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCounts(countDiagnostics(diagnostics));
	const lines = [
		"Background diagnostics snapshot:",
		`Current merged diagnostics: ${counts}.`,
		"Most relevant current issues:",
	];
	for (const diagnostic of diagnostics.slice(0, maxItems)) lines.push(`- ${formatDiagnosticLine(diagnostic)}`);
	if (diagnostics.length > maxItems) lines.push(`- … ${diagnostics.length - maxItems} more diagnostics are available via the diagnostics tool.`);
	return lines.join("\n");
}
