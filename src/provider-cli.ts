import { spawn } from "node:child_process";
import { relative } from "node:path";
import { parseEslintJson, parseGolangciLintJson, parseRuffJson, parseSarif } from "./cli-parsers.js";
import { DiagnosticsStore } from "./diagnostics.js";
import type { BridgeLifecycleConfig, ProviderRuntime, ProviderSpec, ProviderStatus, TriggerReason, UnifiedDiagnostic } from "./types.js";
import { chooseResolvedCommand, now } from "./util.js";

function parseDiagnostics(spec: ProviderSpec, workspaceRoot: string, text: string): UnifiedDiagnostic[] {
	switch (spec.cli?.parser) {
		case "eslint-json":
			return parseEslintJson(spec.id, workspaceRoot, text);
		case "golangci-lint-json":
			return parseGolangciLintJson(spec.id, workspaceRoot, text);
		case "ruff-json":
			return parseRuffJson(spec.id, workspaceRoot, text);
		case "sarif":
			return parseSarif(spec.id, workspaceRoot, text);
		default:
			return [];
	}
}

export class CliProvider implements ProviderRuntime {
	public readonly spec: ProviderSpec;
	private readonly store: DiagnosticsStore;
	private readonly workspaceRoot: string;
	private readonly lifecycle: BridgeLifecycleConfig;
	private status: ProviderStatus = { state: "stopped" };
	private timer: NodeJS.Timeout | undefined;
	private inflight = false;
	private dirty = false;
	private pendingFiles = new Set<string>();
	private pendingResolvers: Array<() => void> = [];
	private backoffUntil = 0;

	constructor(spec: ProviderSpec, workspaceRoot: string, store: DiagnosticsStore, lifecycle: BridgeLifecycleConfig) {
		this.spec = spec;
		this.workspaceRoot = workspaceRoot;
		this.store = store;
		this.lifecycle = lifecycle;
	}

	getStatus(): ProviderStatus {
		return { ...this.status, backoffUntil: this.backoffUntil || undefined };
	}

	async schedule(files: string[], reason: TriggerReason): Promise<void> {
		if (!this.spec.cli) return;
		for (const file of files) this.pendingFiles.add(file);
		if (reason === "startup" && this.spec.cli.runOnStartup === false) return;
		if (reason !== "startup" && this.spec.cli.runOnChange === false) return;
		if (now() < this.backoffUntil) return;
		const delay = this.spec.cli.mode === "workspace" ? this.lifecycle.cliWorkspaceDebounceMs : this.lifecycle.cliDebounceMs;
		if (this.timer) clearTimeout(this.timer);
		const promise = new Promise<void>((resolve) => this.pendingResolvers.push(resolve));
		this.timer = setTimeout(() => {
			void this.flush();
		}, delay);
		return promise;
	}

	private async flush(): Promise<void> {
		if (this.inflight) {
			this.dirty = true;
			return;
		}
		this.inflight = true;
		this.status = { state: "running", lastRunAt: now() };
		const resolved = chooseResolvedCommand(this.workspaceRoot, this.spec.commandCandidates);
		if (!resolved) {
			this.status = { state: "missing", message: `Command not found for ${this.spec.id}` };
			this.pendingFiles.clear();
			this.resolvePending();
			this.inflight = false;
			return;
		}
		const files = Array.from(this.pendingFiles).map((file) => relative(this.workspaceRoot, file) || file);
		this.pendingFiles.clear();
		const args = [...resolved.args];
		if (this.spec.cli?.mode === "files") args.push(...files);
		else if (args.length === 0 || args[args.length - 1] !== ".") args.push(".");
		try {
			const output = await this.exec(resolved.command, args);
			const text = output.stdout.trim() || output.stderr.trim();
			const diagnostics = text ? parseDiagnostics(this.spec, this.workspaceRoot, text) : [];
			if (this.spec.cli?.mode === "workspace") {
				this.store.replaceProviderSnapshot(this.spec.id, diagnostics);
			} else {
				const byFile = new Map<string, UnifiedDiagnostic[]>();
				for (const file of files) byFile.set(file, []);
				for (const diagnostic of diagnostics) {
					const bucket = byFile.get(diagnostic.filePath) ?? [];
					bucket.push(diagnostic);
					byFile.set(diagnostic.filePath, bucket);
				}
				this.store.replaceProviderFiles(this.spec.id, byFile);
			}
			this.status = { state: "cooldown", lastRunAt: now() };
			this.backoffUntil = 0;
		} catch (error) {
			this.backoffUntil = now() + 120_000;
			this.status = { state: "backoff", message: error instanceof Error ? error.message : String(error), backoffUntil: this.backoffUntil };
		}
		this.resolvePending();
		this.inflight = false;
		if (this.dirty) {
			this.dirty = false;
			void this.flush();
		}
	}

	private resolvePending(): void {
		const pending = [...this.pendingResolvers];
		this.pendingResolvers = [];
		for (const resolve of pending) resolve();
	}

	private exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd: this.workspaceRoot,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code !== 0 && !stdout.trim() && !stderr.trim()) {
					reject(new Error(`${this.spec.id} exited with code ${code}`));
					return;
				}
				resolve({ stdout, stderr });
			});
		});
	}

	async suspend(_reason: "idle" | "shutdown" | "reload"): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.status = { state: "stopped", lastRunAt: this.status.lastRunAt };
	}
}
