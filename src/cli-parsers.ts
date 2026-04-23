import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UnifiedDiagnostic } from "./types.js";
import { isPathInside, shouldIgnorePath, stableDiagnosticId } from "./util.js";

function severityFromNumber(value: number | undefined): UnifiedDiagnostic["severity"] {
	if (value === 2) return "warning";
	if (value === 3) return "info";
	if (value === 4) return "hint";
	return "error";
}

function normalizePath(workspaceRoot: string, filePath: string): string | null {
	let absolute: string;
	try {
		if (filePath.startsWith("file://")) {
			absolute = fileURLToPath(filePath);
		} else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(filePath)) {
			return null;
		} else {
			absolute = resolve(workspaceRoot, filePath);
		}
	} catch {
		return null;
	}
	if (!isPathInside(workspaceRoot, absolute) || shouldIgnorePath(workspaceRoot, absolute)) return null;
	const rel = relative(workspaceRoot, absolute).replace(/\\/g, "/");
	return rel === "" ? "." : rel;
}

function buildDiagnostic(providerId: string, sourceKind: UnifiedDiagnostic["sourceKind"], diagnostic: Omit<UnifiedDiagnostic, "id" | "providerId" | "sourceKind">): UnifiedDiagnostic {
	return {
		...diagnostic,
		id: stableDiagnosticId([
			providerId,
			diagnostic.filePath,
			diagnostic.severity,
			diagnostic.code,
			diagnostic.range?.start.line,
			diagnostic.range?.start.character,
			diagnostic.message,
		]),
		providerId,
		sourceKind,
	};
}

export function parseEslintJson(providerId: string, workspaceRoot: string, text: string): UnifiedDiagnostic[] {
	const payload = JSON.parse(text) as Array<{
		filePath: string;
		messages: Array<{
			ruleId?: string | null;
			severity?: number;
			message: string;
			line?: number;
			column?: number;
			endLine?: number;
			endColumn?: number;
		}>;
	}>;
	const diagnostics: UnifiedDiagnostic[] = [];
	for (const result of payload) {
		const filePath = normalizePath(workspaceRoot, result.filePath);
		if (!filePath) continue;
		for (const message of result.messages) {
			diagnostics.push(
				buildDiagnostic(providerId, "cli", {
					filePath,
					severity: severityFromNumber(message.severity),
					message: message.message,
					code: message.ruleId ?? undefined,
					range:
						typeof message.line === "number"
							? {
								start: { line: Math.max(0, message.line - 1), character: Math.max(0, (message.column ?? 1) - 1) },
								end: {
									line: Math.max(0, (message.endLine ?? message.line) - 1),
									character: Math.max(0, (message.endColumn ?? message.column ?? 1) - 1),
								},
							}
							: undefined,
					observedAt: Date.now(),
				}),
			);
		}
	}
	return diagnostics;
}

export function parseGolangciLintJson(providerId: string, workspaceRoot: string, text: string): UnifiedDiagnostic[] {
	const payload = JSON.parse(text) as {
		Issues?: Array<{
			FromLinter?: string;
			Text: string;
			Severity?: string;
			Pos?: {
				Filename?: string;
				Line?: number;
				Column?: number;
			};
		}>;
	};
	const diagnostics: UnifiedDiagnostic[] = [];
	for (const issue of payload.Issues ?? []) {
		const filePath = normalizePath(workspaceRoot, issue.Pos?.Filename ?? "unknown");
		if (!filePath) continue;
		const severity: UnifiedDiagnostic["severity"] = issue.Severity === "warning" ? "warning" : "error";
		diagnostics.push(
			buildDiagnostic(providerId, "cli", {
				filePath,
				severity,
				message: issue.Text,
				code: issue.FromLinter,
				range:
					typeof issue.Pos?.Line === "number"
						? {
							start: { line: Math.max(0, issue.Pos.Line - 1), character: Math.max(0, (issue.Pos.Column ?? 1) - 1) },
							end: { line: Math.max(0, issue.Pos.Line - 1), character: Math.max(0, (issue.Pos.Column ?? 1) - 1) },
						}
						: undefined,
				observedAt: Date.now(),
			}),
		);
	}
	return diagnostics;
}

export function parseRuffJson(providerId: string, workspaceRoot: string, text: string): UnifiedDiagnostic[] {
	const payload = JSON.parse(text) as Array<{
		filename: string;
		code?: string;
		message: string;
		location?: { row: number; column: number };
		end_location?: { row: number; column: number };
	}>;
	const diagnostics: UnifiedDiagnostic[] = [];
	for (const issue of payload) {
		const filePath = normalizePath(workspaceRoot, issue.filename);
		if (!filePath) continue;
		diagnostics.push(
			buildDiagnostic(providerId, "cli", {
				filePath,
				severity: "warning",
				message: issue.message,
				code: issue.code,
				range:
					issue.location
						? {
							start: { line: Math.max(0, issue.location.row - 1), character: Math.max(0, issue.location.column - 1) },
							end: {
								line: Math.max(0, (issue.end_location?.row ?? issue.location.row) - 1),
								character: Math.max(0, (issue.end_location?.column ?? issue.location.column) - 1),
							},
						}
						: undefined,
				observedAt: Date.now(),
			}),
		);
	}
	return diagnostics;
}

export function parseSarif(providerId: string, workspaceRoot: string, text: string): UnifiedDiagnostic[] {
	const payload = JSON.parse(text) as {
		runs?: Array<{
			results?: Array<{
				level?: string;
				message?: { text?: string };
				ruleId?: string;
				locations?: Array<{
					physicalLocation?: {
						artifactLocation?: { uri?: string };
						region?: {
							startLine?: number;
							startColumn?: number;
							endLine?: number;
							endColumn?: number;
						};
					};
				}>;
			}>;
		}>;
	};
	const diagnostics: UnifiedDiagnostic[] = [];
	for (const run of payload.runs ?? []) {
		for (const result of run.results ?? []) {
			const location = result.locations?.[0]?.physicalLocation;
			const filePath = normalizePath(workspaceRoot, location?.artifactLocation?.uri ?? "unknown");
			if (!filePath) continue;
			const severity: UnifiedDiagnostic["severity"] = result.level === "note" ? "info" : result.level === "warning" ? "warning" : "error";
			diagnostics.push(
				buildDiagnostic(providerId, "cli", {
					filePath,
					severity,
					message: result.message?.text ?? "SARIF diagnostic",
					code: result.ruleId,
					range:
						location?.region?.startLine
							? {
								start: {
									line: Math.max(0, location.region.startLine - 1),
									character: Math.max(0, (location.region.startColumn ?? 1) - 1),
								},
								end: {
									line: Math.max(0, (location.region.endLine ?? location.region.startLine) - 1),
									character: Math.max(0, (location.region.endColumn ?? location.region.startColumn ?? 1) - 1),
								},
							}
							: undefined,
					observedAt: Date.now(),
				}),
			);
		}
	}
	return diagnostics;
}
