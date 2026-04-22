import { relative, resolve } from "node:path";
import { CleanupRegistry } from "./cleanup.js";
import { loadConfig, selectProviders } from "./config.js";
import { buildFileSummary, buildPromptSummary, DiagnosticsStore, formatCounts } from "./diagnostics.js";
import { CliProvider } from "./provider-cli.js";
import { LspProvider } from "./provider-lsp.js";
import type { BridgeLifecycleConfig, ProviderRuntime, ProviderSpec, TriggerReason } from "./types.js";
import { findWorkspaceRoot, now, scanWorkspace, toRelative } from "./util.js";

const GLOBAL_HANDLERS = new Set<string>();
let PROCESS_CLEANUP: (() => Promise<void>) | undefined;

function discoveryRelevantFile(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return (
		name === "package.json" ||
		name === ".opencode.json" ||
		name === "lsp-bridge.json" ||
		name === "tsconfig.json" ||
		name === "jsconfig.json" ||
		name === "go.mod" ||
		name === "go.work" ||
		name === "Cargo.toml" ||
		name.startsWith("eslint.config.") ||
		name.startsWith(".eslintrc") ||
		name.startsWith(".golangci") ||
		name === "pyproject.toml" ||
		name === "ruff.toml" ||
		name === ".ruff.toml"
	);
}

export class WorkspaceBridge {
	readonly workspaceRoot: string;
	readonly store = new DiagnosticsStore();
	private lifecycle: BridgeLifecycleConfig;
	private cleanupRegistry: CleanupRegistry;
	private providers: ProviderRuntime[] = [];
	private inventory = scanWorkspace(process.cwd());
	private excludePaths: string[] = [];
	private debug = false;
	private idleTimer: NodeJS.Timeout | undefined;
	private lastInjectionDigest = "";
	private lastInjectionAt = 0;
	private rediscoverTimer: NodeJS.Timeout | undefined;

	private constructor(workspaceRoot: string, lifecycle: BridgeLifecycleConfig, cleanupRegistry: CleanupRegistry) {
		this.workspaceRoot = workspaceRoot;
		this.lifecycle = lifecycle;
		this.cleanupRegistry = cleanupRegistry;
	}

	static create(cwd: string): WorkspaceBridge {
		const workspaceRoot = findWorkspaceRoot(cwd);
		const loaded = loadConfig(workspaceRoot);
		const cleanupRegistry = new CleanupRegistry(workspaceRoot, loaded.lifecycle.orphanSweepMaxAgeMs);
		const bridge = new WorkspaceBridge(workspaceRoot, loaded.lifecycle, cleanupRegistry);
		bridge.debug = loaded.debug;
		bridge.excludePaths = loaded.repoConfig.excludePaths ?? [];
		bridge.rediscover();
		bridge.touchActivity();
		bridge.installProcessHandlers();
		return bridge;
	}

	private installProcessHandlers(): void {
		PROCESS_CLEANUP = () => this.shutdown("shutdown");
		const keys = ["SIGINT", "SIGTERM", "exit", "uncaughtException", "unhandledRejection"];
		for (const key of keys) {
			if (GLOBAL_HANDLERS.has(key)) continue;
			GLOBAL_HANDLERS.add(key);
			if (key === "exit") {
				process.on("exit", () => {
					void PROCESS_CLEANUP?.();
				});
				continue;
			}
			if (key === "uncaughtException") {
				process.on("uncaughtException", () => {
					void PROCESS_CLEANUP?.();
				});
				continue;
			}
			if (key === "unhandledRejection") {
				process.on("unhandledRejection", () => {
					void PROCESS_CLEANUP?.();
				});
				continue;
			}
			process.on(key as NodeJS.Signals, () => {
				void PROCESS_CLEANUP?.();
			});
		}
	}

	private buildProviders(specs: ProviderSpec[]): ProviderRuntime[] {
		return specs.map((spec) => {
			if (spec.kind === "cli") return new CliProvider(spec, this.workspaceRoot, this.store, this.lifecycle);
			return new LspProvider(spec, this.workspaceRoot, this.inventory.files, this.store, this.lifecycle, this.cleanupRegistry);
		});
	}

	rediscover(): void {
		const loaded = loadConfig(this.workspaceRoot);
		this.lifecycle = loaded.lifecycle;
		this.debug = loaded.debug;
		this.excludePaths = loaded.repoConfig.excludePaths ?? [];
		this.inventory = scanWorkspace(this.workspaceRoot, this.excludePaths);
		const specs = selectProviders(this.inventory, loaded);
		const nextProviders = this.buildProviders(specs);
		void this.replaceProviders(nextProviders);
	}

	private async replaceProviders(nextProviders: ProviderRuntime[]): Promise<void> {
		const previous = this.providers;
		this.providers = nextProviders;
		for (const provider of previous) {
			await provider.suspend("reload");
		}
		for (const provider of this.providers) {
			await provider.schedule([], "startup");
		}
	}

	private scheduleRediscover(): void {
		if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
		this.rediscoverTimer = setTimeout(() => this.rediscover(), 2_000);
	}

	touchActivity(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			void this.suspendProviders("idle");
		}, this.lifecycle.idleSuspendMs);
	}

	private async suspendProviders(reason: "idle" | "shutdown" | "reload"): Promise<void> {
		for (const provider of this.providers) await provider.suspend(reason);
	}

	async shutdown(reason: "idle" | "shutdown" | "reload"): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
		await this.suspendProviders(reason);
		if (reason === "shutdown" || reason === "reload") this.cleanupRegistry.dispose();
		if (PROCESS_CLEANUP && (reason === "shutdown" || reason === "reload")) {
			PROCESS_CLEANUP = undefined;
		}
	}

	async handleTouchedFiles(paths: string[], reason: TriggerReason): Promise<string | null> {
		this.touchActivity();
		const files = paths.map((path) => resolve(path)).filter((path) => path.startsWith(this.workspaceRoot));
		if (files.some((file) => discoveryRelevantFile(toRelative(this.workspaceRoot, file)))) {
			this.scheduleRediscover();
		}
		const awaitedProviders = this.providers.filter(
			(provider) => provider.spec.kind === "lsp" || provider.spec.cli?.mode === "files",
		);
		const backgroundProviders = this.providers.filter(
			(provider) => provider.spec.kind === "cli" && provider.spec.cli?.mode === "workspace",
		);
		await Promise.all(awaitedProviders.map((provider) => provider.schedule(files, reason)));
		for (const provider of backgroundProviders) void provider.schedule(files, reason);
		const summaries: string[] = [];
		for (const file of files) {
			const relativePath = relative(this.workspaceRoot, file).replace(/\\/g, "/") || file;
			const summary = buildFileSummary(relativePath, this.store.getByFile(relativePath), 6);
			if (summary) summaries.push(summary);
		}
		return summaries.length > 0 ? summaries.join("\n\n") : null;
	}

	buildPromptContext(): string | null {
		this.touchActivity();
		const diagnostics = this.store.getAll();
		if (diagnostics.length === 0) return null;
		const digest = JSON.stringify({ version: this.store.getVersion(), counts: this.store.getCounts(diagnostics) });
		if (digest === this.lastInjectionDigest && now() - this.lastInjectionAt < this.lifecycle.injectCooldownMs) {
			return null;
		}
		this.lastInjectionDigest = digest;
		this.lastInjectionAt = now();
		return buildPromptSummary(diagnostics, 8);
	}

	statusText(): string {
		const counts = formatCounts(this.store.getCounts());
		const providerText = this.providers
			.map((provider) => `${provider.spec.id}:${provider.getStatus().state}`)
			.join(" ");
		return `lsp-bridge ${counts}${providerText ? ` | ${providerText}` : ""}`;
	}

	diagnosticsText(options?: { path?: string; providerId?: string; maxItems?: number }): string {
		const maxItems = options?.maxItems ?? 25;
		if (options?.providerId) {
			const diagnostics = this.store.getByProvider(options.providerId);
			const summary = buildPromptSummary(diagnostics, maxItems);
			return summary ?? `No diagnostics for provider ${options.providerId}.`;
		}
		if (options?.path) {
			const normalized = options.path.replace(/^@/, "");
			const relativePath = normalized.startsWith(this.workspaceRoot) ? toRelative(this.workspaceRoot, normalized) : normalized;
			const summary = buildFileSummary(relativePath, this.store.getByFile(relativePath), maxItems);
			return summary ?? `No diagnostics for ${relativePath}.`;
		}
		const diagnostics = this.store.getAll();
		const summary = buildPromptSummary(diagnostics, maxItems);
		return summary ?? "No current diagnostics.";
	}
}
