import { accessSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandCandidate, ResolvedCommand, WorkspaceInventory } from "./types.js";

const IGNORE_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"target",
	"coverage",
	".next",
	".turbo",
	".cache",
	"tmp",
	"temp",
]);

export function fileExists(path: string): boolean {
	return existsSync(path);
}

export function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function readJsonFile<T>(path: string): T | null {
	const text = readTextFile(path);
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export function hashText(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

export function hashPath(path: string): string {
	return hashText(path).slice(0, 16);
}

export function normalizePath(path: string): string {
	return resolve(path);
}

export function toRelative(root: string, path: string): string {
	const rel = relative(root, path);
	return rel === "" ? "." : rel.split(sep).join("/");
}

export function findWorkspaceRoot(start: string): string {
	let current = resolve(start);
	let previous = "";
	while (current !== previous) {
		if (existsSync(join(current, ".git"))) return current;
		previous = current;
		current = dirname(current);
	}
	return resolve(start);
}

export function shouldIgnorePath(root: string, filePath: string, excludePaths: string[] = []): boolean {
	const rel = toRelative(root, filePath);
	if (rel === ".") return false;
	const parts = rel.split("/");
	for (const part of parts.slice(0, -1)) {
		if (IGNORE_DIRS.has(part)) return true;
	}
	for (const excluded of excludePaths) {
		if (rel === excluded || rel.startsWith(`${excluded}/`)) return true;
	}
	return false;
}

export function scanWorkspace(root: string, excludePaths: string[] = [], maxFiles = 10_000): WorkspaceInventory {
	const files: string[] = [];
	const basenames = new Set<string>();
	const extensions = new Set<string>();
	const packageJsonDeps = new Set<string>();
	const stack = [root];

	while (stack.length > 0 && files.length < maxFiles) {
		const current = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (shouldIgnorePath(root, full, excludePaths)) continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (shouldIgnorePath(root, full, excludePaths)) continue;
			files.push(full);
			basenames.add(entry.name);
			const extension = extname(entry.name).toLowerCase();
			if (extension) extensions.add(extension);
			if (entry.name === "package.json") {
				const pkg = readJsonFile<Record<string, Record<string, string>>>(full);
				for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
					for (const dep of Object.keys(pkg?.[field] ?? {})) packageJsonDeps.add(dep);
				}
			}
		}
	}

	return { files, basenames, extensions, packageJsonDeps };
}

export function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveFromPath(command: string): string | null {
	const pathValue = process.env.PATH ?? "";
	for (const segment of pathValue.split(":").filter(Boolean)) {
		const candidate = join(segment, command);
		if (fileExists(candidate) && isExecutable(candidate)) return candidate;
	}
	return null;
}

function localCommandSearchRoots(workspaceRoot: string): string[] {
	return [
		join(workspaceRoot, "node_modules", ".bin"),
		join(workspaceRoot, ".venv", "bin"),
		join(workspaceRoot, "venv", "bin"),
		join(workspaceRoot, "bin"),
		join(homedir(), ".local", "bin"),
	];
}

export function resolveCommandCandidate(workspaceRoot: string, candidate: CommandCandidate): ResolvedCommand | null {
	const args = candidate.args ?? [];
	if (isAbsolute(candidate.command)) {
		return fileExists(candidate.command) ? { command: candidate.command, args } : null;
	}
	if (candidate.command.startsWith("./") || candidate.command.startsWith("../")) {
		const full = resolve(workspaceRoot, candidate.command);
		return fileExists(full) ? { command: full, args } : null;
	}
	for (const root of localCommandSearchRoots(workspaceRoot)) {
		const local = join(root, candidate.command);
		if (fileExists(local) && isExecutable(local)) return { command: local, args };
	}
	const global = resolveFromPath(candidate.command);
	return global ? { command: global, args } : null;
}

export function chooseResolvedCommand(workspaceRoot: string, candidates: CommandCandidate[]): ResolvedCommand | null {
	for (const candidate of candidates) {
		const resolved = resolveCommandCandidate(workspaceRoot, candidate);
		if (resolved) return resolved;
	}
	return null;
}

export function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function stableDiagnosticId(parts: Array<string | number | undefined>): string {
	return hashText(parts.filter((part) => part !== undefined).join("|"));
}

export function clipText(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function isLargeFile(path: string, maxBytes: number): boolean {
	try {
		return statSync(path).size > maxBytes;
	} catch {
		return true;
	}
}

export function now(): number {
	return Date.now();
}
