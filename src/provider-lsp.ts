import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { relative } from "node:path";
import type { Logger } from "pino";
import type { BridgeLifecycleConfig, ProviderRuntime, ProviderSpec, ProviderStatus, TriggerReason, UnifiedDiagnostic } from "./types.js";
import { DiagnosticsStore } from "./diagnostics.js";
import { chooseResolvedCommand, isGeneratedFile, isLargeFile, isPathInside, now, shouldIgnorePath, stableDiagnosticId } from "./util.js";

interface OpenDocument {
	uri: string;
	version: number;
	languageId: string;
	lastTouchedAt: number;
}

interface CleanupRegistryLike {
	register(providerId: string, pid: number, pgid?: number): void;
	unregister(providerId: string): void;
}

function severityFromLsp(value: number | undefined): UnifiedDiagnostic["severity"] {
	switch (value) {
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "error";
	}
}

export class LspProvider implements ProviderRuntime {
	public readonly spec: ProviderSpec;
	private readonly workspaceRoot: string;
	private readonly inventoryFiles: string[];
	private readonly store: DiagnosticsStore;
	private readonly lifecycle: BridgeLifecycleConfig;
	private readonly cleanupRegistry: CleanupRegistryLike;
	private readonly onChange: () => void;
	private readonly logger: Logger;
	private readonly excludePaths: string[];
	private status: ProviderStatus = { state: "stopped" };
	private pendingFiles = new Set<string>();
	private pendingResolvers: Array<() => void> = [];
	private timer: NodeJS.Timeout | undefined;
	private process: ChildProcessWithoutNullStreams | undefined;
	private buffer = Buffer.alloc(0);
	private nextRequestId = 0;
	private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private openDocuments = new Map<string, OpenDocument>();
	private waiters = new Map<string, Array<() => void>>();
	private starting: Promise<void> | undefined;
	private inflight = false;
	private dirty = false;
	private backoffUntil = 0;
	private crashTimestamps: number[] = [];
	private bootstrapComplete = false;

	constructor(
		spec: ProviderSpec,
		workspaceRoot: string,
		inventoryFiles: string[],
		store: DiagnosticsStore,
		lifecycle: BridgeLifecycleConfig,
		cleanupRegistry: CleanupRegistryLike,
		onChange: () => void,
		logger: Logger,
		excludePaths: string[] = [],
	) {
		this.spec = spec;
		this.workspaceRoot = workspaceRoot;
		this.inventoryFiles = inventoryFiles;
		this.store = store;
		this.lifecycle = lifecycle;
		this.cleanupRegistry = cleanupRegistry;
		this.onChange = onChange;
		this.logger = logger;
		this.excludePaths = excludePaths;
		this.logger.debug({ commandCandidates: this.spec.commandCandidates, excludePaths }, "lsp provider created");
	}

	getStatus(): ProviderStatus {
		return { ...this.status, backoffUntil: this.backoffUntil || undefined };
	}

	private setStatus(status: ProviderStatus): void {
		const previousState = this.status.state;
		this.status = status;
		if (previousState !== status.state) {
			this.logger.debug({ from: previousState, to: status.state, status }, "lsp provider status changed");
		}
		this.onChange();
	}

	async schedule(files: string[], reason: TriggerReason): Promise<void> {
		for (const file of files) {
			if (this.matchesFile(file)) this.pendingFiles.add(file);
		}
		this.logger.debug({ reason, files, pendingFiles: Array.from(this.pendingFiles) }, "lsp provider scheduled");
		if (reason === "startup" && !this.bootstrapComplete) {
			for (const file of this.bootstrapFiles()) this.pendingFiles.add(file);
		}
		if (this.pendingFiles.size === 0) return;
		if (now() < this.backoffUntil) return;
		if (this.timer) clearTimeout(this.timer);
		const promise = new Promise<void>((resolve) => this.pendingResolvers.push(resolve));
		this.timer = setTimeout(() => {
			void this.flush();
		}, this.lifecycle.lspDebounceMs);
		return promise;
	}

	private bootstrapFiles(): string[] {
		const result: string[] = [];
		const markerSet = new Set([...(this.spec.rootMarkers ?? []), ...(this.spec.configMarkers ?? [])]);
		for (const file of this.inventoryFiles) {
			if (markerSet.has(file.split("/").pop() ?? "")) result.push(file);
		}
		for (const file of this.inventoryFiles) {
			if (result.length >= this.lifecycle.bootstrapSampleFiles) break;
			if (this.matchesFile(file) && !result.includes(file)) result.push(file);
		}
		return result;
	}

	private matchesFile(filePath: string): boolean {
		const selectors = this.spec.selectors ?? [];
		return selectors.some((selector) => selector.extensions?.some((extension) => filePath.endsWith(extension)) ?? false);
	}

	private languageIdForFile(filePath: string): string | null {
		for (const selector of this.spec.selectors ?? []) {
			if (selector.extensions?.some((extension) => filePath.endsWith(extension))) return selector.languageId;
		}
		return null;
	}

	private async flush(): Promise<void> {
		if (this.inflight) {
			this.dirty = true;
			return;
		}
		this.inflight = true;
		this.setStatus({ state: "running", lastRunAt: now() });
		this.logger.debug({ pendingFiles: Array.from(this.pendingFiles) }, "lsp provider flush start");
		try {
			await this.ensureStarted();
			const files = Array.from(this.pendingFiles);
			this.pendingFiles.clear();
			for (const file of files) {
				await this.openOrChange(file);
			}
			this.bootstrapComplete = true;
			await this.waitForDiagnostics(files);
			this.logger.debug({ files }, "lsp provider flush success");
			this.setStatus({ state: "cooldown", lastRunAt: now() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn({ error: message }, "lsp provider flush failed");
			if (this.status.state === "missing") {
				this.teardownProcess();
			} else {
				this.registerCrash(message);
			}
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

	private registerCrash(message: string): void {
		this.logger.warn({ message }, "lsp provider crash registered");
		const timestamp = now();
		this.crashTimestamps = this.crashTimestamps.filter((value) => timestamp - value < 10 * 60_000);
		this.crashTimestamps.push(timestamp);
		const attempts = this.crashTimestamps.length;
		const backoff = attempts === 1 ? 5_000 : attempts === 2 ? 15_000 : attempts === 3 ? 45_000 : 120_000;
		this.backoffUntil = timestamp + backoff;
		this.teardownProcess();
		this.setStatus({
			state: attempts >= 5 ? "disabled" : "backoff",
			message,
			backoffUntil: this.backoffUntil,
		});
	}

	private async ensureStarted(): Promise<void> {
		if (this.process) return;
		if (this.status.state === "disabled") {
			throw new Error(`${this.spec.id} disabled after repeated crashes`);
		}
		if (this.starting) return this.starting;
		const resolved = chooseResolvedCommand(this.workspaceRoot, this.spec.commandCandidates);
		if (!resolved) {
			this.store.clearProvider(this.spec.id);
			this.logger.warn("lsp provider command not found");
			this.setStatus({ state: "missing", message: `Command not found for ${this.spec.id}` });
			throw new Error(`Command not found for ${this.spec.id}`);
		}
		this.logger.debug({ resolved }, "lsp provider starting process");
		this.starting = new Promise<void>((resolve, reject) => {
			const child = spawn(resolved.command, resolved.args, {
				cwd: this.workspaceRoot,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			this.process = child;
			this.setStatus({ state: "starting", lastRunAt: now() });
			this.cleanupRegistry.register(this.spec.id, child.pid ?? -1, process.platform !== "win32" ? child.pid : undefined);
			child.stdout.on("data", (chunk: Buffer) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				this.consumeMessages();
			});
			child.stderr.on("data", () => {
				// Intentionally ignored in MVP; pi command output would be too noisy here.
			});
			child.on("error", reject);
			child.on("close", () => {
				this.process = undefined;
				this.cleanupRegistry.unregister(this.spec.id);
				for (const request of this.pendingRequests.values()) request.reject(new Error(`${this.spec.id} terminated`));
				this.pendingRequests.clear();
			});
			void (async () => {
				try {
					await this.request("initialize", {
						processId: process.pid,
						rootPath: this.workspaceRoot,
						rootUri: pathToFileURL(this.workspaceRoot).toString(),
						capabilities: {
							workspace: {
								configuration: true,
								workspaceFolders: true,
							},
							textDocument: {
								publishDiagnostics: {
									relatedInformation: true,
									tagSupport: { valueSet: [1, 2] },
								},
								synchronization: { didSave: true, dynamicRegistration: false },
							},
						},
						initializationOptions: this.spec.lsp?.initializationOptions ?? {},
					});
					this.notify("initialized", {});
					resolve();
				} catch (error) {
					reject(error);
				}
			})();
		});
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async openOrChange(filePath: string): Promise<void> {
		if (isLargeFile(filePath, this.lifecycle.maxFileBytes)) return;
		const languageId = this.languageIdForFile(filePath);
		if (!languageId) return;
		const fs = await import("node:fs/promises");
		const text = await fs.readFile(filePath, "utf8");
		const uri = pathToFileURL(filePath).toString();
		const existing = this.openDocuments.get(filePath);
		this.ensureDocumentBudget(filePath);
		if (!existing) {
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			});
			this.openDocuments.set(filePath, { uri, languageId, version: 1, lastTouchedAt: now() });
			return;
		}
		existing.version += 1;
		existing.lastTouchedAt = now();
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: existing.version },
			contentChanges: [{ text }],
		});
	}

	private ensureDocumentBudget(incomingFile: string): void {
		if (this.openDocuments.size < this.lifecycle.maxOpenDocuments || this.openDocuments.has(incomingFile)) return;
		const oldest = Array.from(this.openDocuments.entries()).sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt)[0];
		if (!oldest) return;
		this.notify("textDocument/didClose", { textDocument: { uri: oldest[1].uri } });
		this.openDocuments.delete(oldest[0]);
	}

	private waitForDiagnostics(files: string[]): Promise<void> {
		if (files.length === 0) return Promise.resolve();
		return new Promise((resolve) => {
			let resolved = false;
			const cleanup = () => {
				for (const file of files) {
					const waiters = this.waiters.get(file);
					if (!waiters || waiters.length === 0) continue;
					this.waiters.delete(file);
				}
			};
			const finish = () => {
				if (resolved) return;
				resolved = true;
				cleanup();
				resolve();
			};
			const timer = setTimeout(finish, 1200);
			for (const file of files) {
				const waiters = this.waiters.get(file) ?? [];
				waiters.push(() => {
					clearTimeout(timer);
					finish();
				});
				this.waiters.set(file, waiters);
			}
		});
	}

	private consumeMessages(): void {
		for (;;) {
			const separator = Buffer.from("\r\n\r\n");
			const separatorIndex = this.buffer.indexOf(separator);
			if (separatorIndex === -1) return;
			const header = this.buffer.subarray(0, separatorIndex).toString("utf8");
			const match = header.match(/Content-Length: (\d+)/i);
			if (!match) {
				this.buffer = this.buffer.subarray(separatorIndex + separator.length);
				continue;
			}
			const contentLength = Number.parseInt(match[1], 10);
			const start = separatorIndex + separator.length;
			const end = start + contentLength;
			if (this.buffer.length < end) return;
			const payload = this.buffer.subarray(start, end).toString("utf8");
			this.buffer = this.buffer.subarray(end);
			const message = JSON.parse(payload) as any;
			this.handleMessage(message);
		}
	}

	private handleMessage(message: any): void {
		if (typeof message.id === "number" && ("result" in message || "error" in message)) {
			const pending = this.pendingRequests.get(message.id);
			if (!pending) return;
			this.pendingRequests.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message ?? `${this.spec.id} request failed`));
			else pending.resolve(message.result);
			return;
		}
		if (typeof message.method !== "string") return;
		if (message.method === "textDocument/publishDiagnostics") {
			const uri = message.params?.uri as string | undefined;
			if (!uri || !uri.startsWith("file:")) return;
			let filePath: string;
			try {
				filePath = fileURLToPath(uri);
			} catch {
				return;
			}
			if (!isPathInside(this.workspaceRoot, filePath) || shouldIgnorePath(this.workspaceRoot, filePath, this.excludePaths)) return;
			const relativePath = relative(this.workspaceRoot, filePath).replace(/\\/g, "/") || filePath;
			if (isGeneratedFile(this.workspaceRoot, filePath)) {
				this.store.replaceProviderFiles(this.spec.id, new Map([[relativePath, []]]));
				this.logger.debug({ filePath: relativePath }, "lsp diagnostics ignored for generated file");
				this.onChange();
				const waiters = this.waiters.get(filePath) ?? this.waiters.get(relativePath) ?? [];
				for (const waiter of waiters) waiter();
				this.waiters.delete(filePath);
				this.waiters.delete(relativePath);
				return;
			}
			const diagnostics = ((message.params?.diagnostics ?? []) as any[]).map((diagnostic) => ({
				id: stableDiagnosticId([
					this.spec.id,
					relativePath,
					diagnostic.code,
					diagnostic.range?.start?.line,
					diagnostic.range?.start?.character,
					diagnostic.message,
				]),
				providerId: this.spec.id,
				sourceKind: "lsp" as const,
				filePath: relativePath,
				severity: severityFromLsp(diagnostic.severity),
				message: diagnostic.message,
				code: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? String(diagnostic.code) : undefined,
				range: diagnostic.range
					? {
						start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
						end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
					}
					: undefined,
				tags: Array.isArray(diagnostic.tags)
					? diagnostic.tags.map((tag: number) => (tag === 1 ? "unnecessary" : "deprecated"))
					: undefined,
				observedAt: now(),
			})) satisfies UnifiedDiagnostic[];
			this.store.replaceProviderFiles(this.spec.id, new Map([[relativePath, diagnostics]]));
			this.logger.debug({ filePath: relativePath, diagnostics: diagnostics.length }, "lsp diagnostics published");
			this.onChange();
			const waiters = this.waiters.get(filePath) ?? this.waiters.get(relativePath) ?? [];
			for (const waiter of waiters) waiter();
			this.waiters.delete(filePath);
			this.waiters.delete(relativePath);
			return;
		}
		if (typeof message.id === "number") {
			this.respondToServerRequest(message);
		}
	}

	private respondToServerRequest(message: any): void {
		const id = message.id;
		const method = message.method as string;
		let result: unknown = null;
		if (method === "workspace/configuration") {
			const items = (message.params?.items as Array<unknown>) ?? [];
			result = items.map(() => ({}));
		} else if (method === "workspace/workspaceFolders") {
			result = [{ uri: pathToFileURL(this.workspaceRoot).toString(), name: this.workspaceRoot.split("/").pop() ?? this.workspaceRoot }];
		} else if (method === "workspace/applyEdit") {
			result = { applied: false };
		} else if (method === "client/registerCapability" || method === "client/unregisterCapability" || method === "window/workDoneProgress/create") {
			result = null;
		}
		this.writeMessage({ jsonrpc: "2.0", id, result });
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.nextRequestId;
		this.writeMessage({ jsonrpc: "2.0", id, method, params });
		return new Promise<unknown>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			setTimeout(() => {
				if (!this.pendingRequests.has(id)) return;
				this.pendingRequests.delete(id);
				reject(new Error(`${this.spec.id} request timed out: ${method}`));
			}, 10_000);
		});
	}

	private notify(method: string, params: unknown): void {
		this.writeMessage({ jsonrpc: "2.0", method, params });
	}

	private writeMessage(message: unknown): void {
		if (!this.process?.stdin.writable) return;
		const payload = JSON.stringify(message);
		this.process.stdin.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
	}

	private teardownProcess(): void {
		this.logger.debug("lsp provider tearing down process");
		for (const document of this.openDocuments.values()) {
			this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
		}
		this.openDocuments.clear();
		if (this.process) {
			this.notify("exit", null);
			const pid = this.process.pid;
			this.process.kill();
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// ignore
				}
			}
		}
		this.process = undefined;
		this.cleanupRegistry.unregister(this.spec.id);
	}

	async suspend(reason: "idle" | "shutdown" | "reload"): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.logger.debug({ reason }, "lsp provider suspended");
		this.teardownProcess();
		this.setStatus({ state: "stopped", lastRunAt: this.status.lastRunAt });
	}
}
