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
const PI_PEER_DEPENDENCY_HINT =
	"Hint: Pi peer dependency not resolvable from workspace node_modules; run npm install or configure Pi SDK paths.";
const PI_PEER_DEPENDENCY_MODULES = new Set(["typebox", "@sinclair/typebox"]);
const SECONDARY_DIAGNOSTIC_GROUP_MIN_COUNT = 2;
const MISSING_MODULE_PATTERNS = [
	/Cannot find module ['"]([^'"]+)['"]/u,
	/Could not find a declaration file for module ['"]([^'"]+)['"]/u,
];

type DiagnosticSummaryEntry =
	| { kind: "single"; diagnostic: UnifiedDiagnostic }
	| { kind: "group"; representative: UnifiedDiagnostic; diagnostics: UnifiedDiagnostic[]; filePaths: string[] }
	| { kind: "secondary"; roots: UnifiedDiagnostic[]; diagnostics: UnifiedDiagnostic[]; filePaths: string[] };

interface ModuleResolutionCluster {
	rootsByFile: Map<string, UnifiedDiagnostic[]>;
	secondaryByFile: Map<string, UnifiedDiagnostic[]>;
	secondaryIds: Set<string>;
	rootCount: number;
	secondaryCount: number;
}

export function diagnosticIssueKey(diagnostic: UnifiedDiagnostic): string {
	return stableDiagnosticId([
		diagnostic.providerId,
		diagnostic.sourceKind,
		diagnostic.severity,
		diagnostic.code,
		compactWhitespace(diagnostic.message),
	]);
}

function missingModuleName(diagnostic: UnifiedDiagnostic): string | null {
	if (diagnostic.severity !== "error") return null;
	for (const pattern of MISSING_MODULE_PATTERNS) {
		const match = diagnostic.message.match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
}

function isModuleResolutionRoot(diagnostic: UnifiedDiagnostic): boolean {
	return missingModuleName(diagnostic) !== null;
}

function isPiPeerDependencyModule(moduleName: string): boolean {
	return (
		moduleName.startsWith("@mariozechner/pi-") ||
		moduleName === "typebox" ||
		moduleName.startsWith("typebox/") ||
		moduleName === "@sinclair/typebox" ||
		moduleName.startsWith("@sinclair/typebox/") ||
		PI_PEER_DEPENDENCY_MODULES.has(moduleName)
	);
}

function isPiPeerDependencyRoot(diagnostic: UnifiedDiagnostic): boolean {
	const moduleName = missingModuleName(diagnostic);
	return moduleName !== null && isPiPeerDependencyModule(moduleName);
}

function collectModuleResolutionCluster(diagnostics: UnifiedDiagnostic[]): ModuleResolutionCluster {
	const rootsByFile = new Map<string, UnifiedDiagnostic[]>();
	for (const diagnostic of diagnostics) {
		if (!isModuleResolutionRoot(diagnostic)) continue;
		const roots = rootsByFile.get(diagnostic.filePath) ?? [];
		roots.push(diagnostic);
		rootsByFile.set(diagnostic.filePath, roots);
	}

	const secondaryByFile = new Map<string, UnifiedDiagnostic[]>();
	const secondaryIds = new Set<string>();
	for (const [filePath, roots] of rootsByFile) {
		const secondary = diagnostics.filter((diagnostic) => diagnostic.filePath === filePath && !roots.some((root) => root.id === diagnostic.id));
		if (secondary.length < SECONDARY_DIAGNOSTIC_GROUP_MIN_COUNT) continue;
		secondaryByFile.set(filePath, secondary);
		for (const diagnostic of secondary) secondaryIds.add(diagnostic.id);
	}

	const rootCount = Array.from(rootsByFile.values()).reduce((count, roots) => count + roots.length, 0);
	const secondaryCount = Array.from(secondaryByFile.values()).reduce((count, secondary) => count + secondary.length, 0);
	return { rootsByFile, secondaryByFile, secondaryIds, rootCount, secondaryCount };
}

function uniqueFilePaths(diagnostics: UnifiedDiagnostic[]): string[] {
	return Array.from(new Set(diagnostics.map((diagnostic) => diagnostic.filePath))).sort((left, right) => left.localeCompare(right));
}

function buildSummaryEntries(diagnostics: UnifiedDiagnostic[]): DiagnosticSummaryEntry[] {
	const sorted = sortDiagnostics(diagnostics);
	const cluster = collectModuleResolutionCluster(sorted);
	const buckets = new Map<string, UnifiedDiagnostic[]>();
	for (const diagnostic of sorted) {
		if (cluster.secondaryIds.has(diagnostic.id)) continue;
		const key = diagnosticIssueKey(diagnostic);
		const bucket = buckets.get(key) ?? [];
		bucket.push(diagnostic);
		buckets.set(key, bucket);
	}

	const emittedGroups = new Set<string>();
	const emittedSecondaryFiles = new Set<string>();
	const entries: DiagnosticSummaryEntry[] = [];
	const appendSecondaryForFiles = (filePaths: string[]) => {
		const diagnosticsForFiles: UnifiedDiagnostic[] = [];
		const filesWithSecondary: string[] = [];
		const rootsForFiles: UnifiedDiagnostic[] = [];
		for (const filePath of filePaths) {
			rootsForFiles.push(...(cluster.rootsByFile.get(filePath) ?? []));
			if (emittedSecondaryFiles.has(filePath)) continue;
			const secondary = cluster.secondaryByFile.get(filePath) ?? [];
			if (secondary.length === 0) continue;
			emittedSecondaryFiles.add(filePath);
			diagnosticsForFiles.push(...secondary);
			filesWithSecondary.push(filePath);
		}
		if (diagnosticsForFiles.length === 0) return;
		entries.push({ kind: "secondary", roots: rootsForFiles, diagnostics: diagnosticsForFiles, filePaths: filesWithSecondary });
	};

	for (const diagnostic of sorted) {
		if (cluster.secondaryIds.has(diagnostic.id)) continue;
		const key = diagnosticIssueKey(diagnostic);
		const bucket = buckets.get(key) ?? [diagnostic];
		const filePaths = uniqueFilePaths(bucket);
		if (filePaths.length >= REPEATED_DIAGNOSTIC_MIN_FILES) {
			if (emittedGroups.has(key)) continue;
			emittedGroups.add(key);
			entries.push({ kind: "group", representative: bucket[0] ?? diagnostic, diagnostics: bucket, filePaths });
			if (bucket.some(isModuleResolutionRoot)) appendSecondaryForFiles(filePaths);
			continue;
		}
		entries.push({ kind: "single", diagnostic });
		if (isModuleResolutionRoot(diagnostic)) appendSecondaryForFiles([diagnostic.filePath]);
	}
	return entries;
}

function countDiagnosticsInEntries(entries: DiagnosticSummaryEntry[]): number {
	return entries.reduce((count, entry) => count + (entry.kind === "single" ? 1 : entry.diagnostics.length), 0);
}

function formatCountsWithCluster(diagnostics: UnifiedDiagnostic[]): string {
	const counts = formatCounts(countDiagnostics(diagnostics));
	const cluster = collectModuleResolutionCluster(diagnostics);
	if (cluster.secondaryCount === 0) return counts;
	const secondaryPlural = cluster.secondaryCount === 1 ? "diagnostic" : "diagnostics";
	const rootPlural = cluster.rootCount === 1 ? "root" : "roots";
	return `${counts} (${cluster.secondaryCount} secondary ${secondaryPlural} grouped under ${cluster.rootCount} module-resolution ${rootPlural})`;
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
	const hint = isPiPeerDependencyRoot(entry.representative) ? ` ${PI_PEER_DEPENDENCY_HINT}` : "";
	return `${entry.representative.severity.toUpperCase()}: repeated in ${occurrences}${code} ${clipText(
		compactWhitespace(entry.representative.message),
		220,
	)}${examples}${hint}`;
}

function formatSecondaryDiagnostics(entry: Extract<DiagnosticSummaryEntry, { kind: "secondary" }>): string {
	const rootCount = entry.roots.length;
	const moduleNames = Array.from(new Set(entry.roots.map(missingModuleName).filter((name): name is string => name !== null)));
	const displayedModules = moduleNames.slice(0, SUMMARY_EXAMPLE_FILE_LIMIT);
	const moreModules = moduleNames.length > SUMMARY_EXAMPLE_FILE_LIMIT ? `, … ${moduleNames.length - SUMMARY_EXAMPLE_FILE_LIMIT} more` : "";
	const moduleText = displayedModules.length > 0 ? ` (${displayedModules.join(", ")}${moreModules})` : "";
	const fileText = entry.filePaths.length === 1 ? entry.filePaths[0] : `${entry.filePaths.length} files`;
	const diagnosticPlural = entry.diagnostics.length === 1 ? "diagnostic" : "diagnostics";
	const rootPlural = rootCount === 1 ? "root" : "roots";
	return `SECONDARY: grouped ${entry.diagnostics.length} additional ${diagnosticPlural} in ${fileText} under ${rootCount} module-resolution ${rootPlural}${moduleText}. Fix the root import error first, then re-check the full diagnostics.`;
}

function formatSummaryEntry(entry: DiagnosticSummaryEntry): string {
	switch (entry.kind) {
		case "group":
			return formatDiagnosticGroup(entry);
		case "secondary":
			return formatSecondaryDiagnostics(entry);
		case "single":
			return formatDiagnosticLine(entry.diagnostic);
	}
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
	const hint = isPiPeerDependencyRoot(diagnostic) ? ` ${PI_PEER_DEPENDENCY_HINT}` : "";
	return `${diagnostic.severity.toUpperCase()}: ${diagnostic.filePath}${location}${code} ${clipText(compactWhitespace(diagnostic.message), 220)}${hint}`;
}

export function buildFileSummary(filePath: string, diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCountsWithCluster(diagnostics);
	const entries = buildSummaryEntries(diagnostics);
	const lines = [`Diagnostics for ${filePath}: ${counts}`];
	for (const entry of entries.slice(0, maxItems)) lines.push(`- ${formatSummaryEntry(entry)}`);
	const remainingCount = countDiagnosticsInEntries(entries.slice(maxItems));
	if (remainingCount > 0) lines.push(`- … ${remainingCount} more`);
	return lines.join("\n");
}

export function buildDiagnosticsUpdateSummary(diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCountsWithCluster(diagnostics);
	const entries = buildSummaryEntries(diagnostics);
	const lines = [`Current diagnostics for touched files: ${counts}.`];
	for (const entry of entries.slice(0, maxItems)) lines.push(`- ${formatSummaryEntry(entry)}`);
	const remainingCount = countDiagnosticsInEntries(entries.slice(maxItems));
	if (remainingCount > 0) lines.push(`- … ${remainingCount} more diagnostics are available via the diagnostics tool.`);
	return lines.join("\n");
}

export function buildPromptSummary(diagnostics: UnifiedDiagnostic[], maxItems = 8): string | null {
	if (diagnostics.length === 0) return null;
	const counts = formatCountsWithCluster(diagnostics);
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
