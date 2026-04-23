import { relative, resolve } from "node:path";
import type { Logger } from "pino";
import { CleanupRegistry } from "./cleanup.js";
import { loadConfig, selectProviders, shouldAutostartProvider } from "./config.js";
import { buildFileSummary, buildPromptSummary, DiagnosticsStore, formatStatusCounts } from "./diagnostics.js";
import { createSessionLogger } from "./logger.js";
import { CliProvider } from "./provider-cli.js";
import { LspProvider } from "./provider-lsp.js";
import type {
	BridgeLifecycleConfig,
	ProviderRuntime,
	ProviderSpec,
	ProviderStatus,
	StatusSymbolsMode,
	TriggerReason,
} from "./types.js";
import { findWorkspaceRoot, hashText, isPathInside, now, scanWorkspace, shouldIgnorePath, toRelative } from "./util.js";

const GLOBAL_HANDLERS = new Set<string>();
let PROCESS_CLEANUP: (() => Promise<void>) | undefined;

const NF_ICON_DEFAULT = "\ue64e";
const NF_ICON_CONFIG = "\ue615";
const NF_ICON_JAVASCRIPT = "\ue60c";
const NF_ICON_TYPESCRIPT = "\ue628";
const NF_ICON_ESLINT = "\ue7d2";
const NF_ICON_GO = "\ue627";
const NF_ICON_RUST = "\ue68b";
const NF_ICON_PYTHON = "\ue606";
const NF_ICON_CPP = "\ue646";
const NF_ICON_YAML = "\ue6a8";
const NF_ICON_JSON = "\ue60b";
const NF_ICON_SHELL = "\ue691";
const NF_ICON_HTML = "\ue60e";
const NF_ICON_CSS = "\ue614";
const NF_ICON_MARKDOWN = "\ue609";

const NF_STATE_STARTING = "\ueb19";
const NF_STATE_RUNNING = "\ueb2c";
const NF_STATE_STOPPED = "\ueba5";
const NF_STATE_COOLDOWN = "\uead1";
const NF_STATE_BACKOFF = "\uea77";
const NF_STATE_MISSING = "\uea6c";
const NF_STATE_DISABLED = "\ueabd";

const PROVIDER_ICON_BY_ID: Record<string, string> = {
	"typescript-language-server": NF_ICON_TYPESCRIPT,
	eslint: NF_ICON_ESLINT,
	gopls: NF_ICON_GO,
	"golangci-lint": NF_ICON_GO,
	"rust-analyzer": NF_ICON_RUST,
	pyright: NF_ICON_PYTHON,
	ruff: NF_ICON_PYTHON,
	clangd: NF_ICON_CPP,
	"yaml-language-server": NF_ICON_YAML,
	"json-language-server": NF_ICON_JSON,
	"bash-language-server": NF_ICON_SHELL,
	"html-language-server": NF_ICON_HTML,
	"css-language-server": NF_ICON_CSS,
	marksman: NF_ICON_MARKDOWN,
};

const PROVIDER_LABEL_BY_ID: Record<string, string> = {
	"typescript-language-server": "ts",
	eslint: "eslint",
	gopls: "go",
	"golangci-lint": "golint",
	"rust-analyzer": "rust",
	pyright: "py",
	ruff: "ruff",
	clangd: "cpp",
	"yaml-language-server": "yml",
	"json-language-server": "json",
	"bash-language-server": "sh",
	"html-language-server": "html",
	"css-language-server": "css",
	marksman: "md",
};

const PROVIDER_ICON_BY_FAMILY: Record<string, string> = {
	"javascript-typescript": NF_ICON_JAVASCRIPT,
	go: NF_ICON_GO,
	rust: NF_ICON_RUST,
	python: NF_ICON_PYTHON,
	"c-cpp": NF_ICON_CPP,
	yaml: NF_ICON_YAML,
	json: NF_ICON_JSON,
	shell: NF_ICON_SHELL,
	html: NF_ICON_HTML,
	css: NF_ICON_CSS,
	markdown: NF_ICON_MARKDOWN,
};

const PROVIDER_LABEL_BY_FAMILY: Record<string, string> = {
	"javascript-typescript": "js",
	go: "go",
	rust: "rust",
	python: "py",
	"c-cpp": "cpp",
	yaml: "yml",
	json: "json",
	shell: "sh",
	html: "html",
	css: "css",
	markdown: "md",
};

const STATE_ICON_BY_STATUS: Record<ProviderStatus["state"], string> = {
	stopped: NF_STATE_STOPPED,
	starting: NF_STATE_STARTING,
	running: NF_STATE_RUNNING,
	cooldown: NF_STATE_COOLDOWN,
	backoff: NF_STATE_BACKOFF,
	missing: NF_STATE_MISSING,
	disabled: NF_STATE_DISABLED,
};

const STATE_LABEL_BY_STATUS: Record<ProviderStatus["state"], string> = {
	stopped: "stopped",
	starting: "starting",
	running: "running",
	cooldown: "cooldown",
	backoff: "backoff",
	missing: "missing",
	disabled: "disabled",
};

function inferProviderIcon(id: string): string | undefined {
	const normalized = id.toLowerCase();
	if (normalized.includes("eslint")) return NF_ICON_ESLINT;
	if (normalized.includes("typescript") || normalized.includes("tsserver") || normalized.includes("vtsls")) return NF_ICON_TYPESCRIPT;
	if (normalized.includes("javascript")) return NF_ICON_JAVASCRIPT;
	if (normalized.includes("golangci") || normalized.includes("gopls") || normalized.includes("go")) return NF_ICON_GO;
	if (normalized.includes("rust")) return NF_ICON_RUST;
	if (normalized.includes("python") || normalized.includes("pyright") || normalized.includes("pylsp") || normalized.includes("ruff")) return NF_ICON_PYTHON;
	if (normalized.includes("clang") || normalized.includes("cpp") || normalized.includes("c++")) return NF_ICON_CPP;
	if (normalized.includes("yaml") || normalized.includes("yml")) return NF_ICON_YAML;
	if (normalized.includes("json")) return NF_ICON_JSON;
	if (normalized.includes("bash") || normalized.includes("shell")) return NF_ICON_SHELL;
	if (normalized.includes("html")) return NF_ICON_HTML;
	if (normalized.includes("css")) return NF_ICON_CSS;
	if (normalized.includes("markdown") || normalized.includes("marksman")) return NF_ICON_MARKDOWN;
	return undefined;
}

function inferProviderLabel(id: string): string {
	const normalized = id.toLowerCase();
	if (normalized.includes("eslint")) return "eslint";
	if (normalized.includes("typescript") || normalized.includes("tsserver") || normalized.includes("vtsls")) return "ts";
	if (normalized.includes("javascript")) return "js";
	if (normalized.includes("golangci")) return "golint";
	if (normalized.includes("gopls") || normalized.includes("go")) return "go";
	if (normalized.includes("rust")) return "rust";
	if (normalized.includes("python") || normalized.includes("pyright") || normalized.includes("pylsp")) return "py";
	if (normalized.includes("ruff")) return "ruff";
	if (normalized.includes("clang") || normalized.includes("cpp") || normalized.includes("c++")) return "cpp";
	if (normalized.includes("yaml") || normalized.includes("yml")) return "yml";
	if (normalized.includes("json")) return "json";
	if (normalized.includes("bash") || normalized.includes("shell")) return "sh";
	if (normalized.includes("html")) return "html";
	if (normalized.includes("css")) return "css";
	if (normalized.includes("markdown") || normalized.includes("marksman")) return "md";
	return normalized
		.replace(/-language-server$/u, "")
		.replace(/-langserver$/u, "")
		.replace(/-analyzer$/u, "")
		.replace(/[^a-z0-9+]+/gu, "-");
}

function providerStatusIcon(spec: ProviderSpec): string {
	return (
		PROVIDER_ICON_BY_ID[spec.id] ??
		(spec.family ? PROVIDER_ICON_BY_FAMILY[spec.family] : undefined) ??
		inferProviderIcon(spec.id) ??
		(spec.kind === "cli" ? NF_ICON_CONFIG : NF_ICON_DEFAULT)
	);
}

function providerStatusLabel(spec: ProviderSpec): string {
	return PROVIDER_LABEL_BY_ID[spec.id] ?? (spec.family ? PROVIDER_LABEL_BY_FAMILY[spec.family] : undefined) ?? inferProviderLabel(spec.id);
}

function formatProviderStatus(spec: ProviderSpec, status: ProviderStatus, symbols: StatusSymbolsMode): string {
	if (symbols === "text") return `${providerStatusLabel(spec)}:${STATE_LABEL_BY_STATUS[status.state]}`;
	return `${providerStatusIcon(spec)} ${STATE_ICON_BY_STATUS[status.state]}`;
}

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
	private readonly logger: Logger;
	private readonly debugLogPath?: string;
	private providers: ProviderRuntime[] = [];
	private readonly listeners = new Set<() => void>();
	private inventory = scanWorkspace(process.cwd());
	private excludePaths: string[] = [];
	private debug = false;
	private statusSymbols: StatusSymbolsMode = "nerdfont";
	private idleTimer: NodeJS.Timeout | undefined;
	private lastInjectionDigest = "";
	private lastInjectionAt = 0;
	private lastSurfacedSummaryDigest = "";
	private rediscoverTimer: NodeJS.Timeout | undefined;

	private constructor(
		workspaceRoot: string,
		lifecycle: BridgeLifecycleConfig,
		cleanupRegistry: CleanupRegistry,
		logger: Logger,
		debugLogPath?: string,
	) {
		this.workspaceRoot = workspaceRoot;
		this.lifecycle = lifecycle;
		this.cleanupRegistry = cleanupRegistry;
		this.logger = logger;
		this.debugLogPath = debugLogPath;
	}

	static create(cwd: string, options?: { sessionId?: string }): WorkspaceBridge {
		const workspaceRoot = findWorkspaceRoot(cwd);
		const loaded = loadConfig(workspaceRoot);
		const cleanupRegistry = new CleanupRegistry(workspaceRoot, loaded.lifecycle.orphanSweepMaxAgeMs);
		const sessionLogger = createSessionLogger({ enabled: loaded.debug, sessionId: options?.sessionId, workspaceRoot });
		const bridge = new WorkspaceBridge(workspaceRoot, loaded.lifecycle, cleanupRegistry, sessionLogger.logger, sessionLogger.filePath);
		bridge.debug = loaded.debug;
		bridge.excludePaths = loaded.repoConfig.excludePaths ?? [];
		bridge.statusSymbols = loaded.status.symbols;
		bridge.logDebug("bridge.create", {
			sessionId: options?.sessionId,
			debug: loaded.debug,
			statusSymbols: loaded.status.symbols,
			excludePaths: bridge.excludePaths,
			debugLogPath: sessionLogger.filePath,
		});
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

	getDebugLogPath(): string | undefined {
		return this.debugLogPath;
	}

	logDebug(message: string, details?: Record<string, unknown>): void {
		this.logger.debug(details ?? {}, message);
	}

	private buildProviders(specs: ProviderSpec[]): ProviderRuntime[] {
		this.logDebug("providers.build", { providerIds: specs.map((spec) => spec.id) });
		return specs.map((spec) => {
			const providerLogger = this.logger.child({ providerId: spec.id, providerKind: spec.kind });
			if (spec.kind === "cli") return new CliProvider(spec, this.workspaceRoot, this.store, this.lifecycle, () => this.emitChange(), providerLogger);
			return new LspProvider(
				spec,
				this.workspaceRoot,
				this.inventory.files,
				this.store,
				this.lifecycle,
				this.cleanupRegistry,
				() => this.emitChange(),
				providerLogger,
				this.excludePaths,
			);
		});
	}

	rediscover(): void {
		const loaded = loadConfig(this.workspaceRoot);
		this.lifecycle = loaded.lifecycle;
		this.debug = loaded.debug;
		this.excludePaths = loaded.repoConfig.excludePaths ?? [];
		this.statusSymbols = loaded.status.symbols;
		this.inventory = scanWorkspace(this.workspaceRoot, this.excludePaths);
		const specs = selectProviders(this.inventory, loaded);
		this.logDebug("bridge.rediscover", {
			debug: loaded.debug,
			files: this.inventory.files.length,
			extensions: this.inventory.extensions.size,
			packageDeps: this.inventory.packageJsonDeps.size,
			selectedProviders: specs.map((spec) => spec.id),
		});
		const nextProviders = this.buildProviders(specs);
		void this.replaceProviders(nextProviders);
	}

	private async replaceProviders(nextProviders: ProviderRuntime[]): Promise<void> {
		const previous = this.providers;
		this.providers = nextProviders;
		for (const provider of previous) {
			await provider.suspend("reload");
			this.store.clearProvider(provider.spec.id);
		}
		this.emitChange();
		const autostartProviders = this.providers.filter((provider) => shouldAutostartProvider(provider.spec, this.inventory));
		this.logDebug("providers.replace", {
			previous: previous.map((provider) => provider.spec.id),
			next: nextProviders.map((provider) => provider.spec.id),
			autostart: autostartProviders.map((provider) => provider.spec.id),
		});
		await Promise.all(autostartProviders.map((provider) => provider.schedule([], "startup")));
	}

	private scheduleRediscover(): void {
		if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
		this.logDebug("bridge.rediscover.scheduled");
		this.rediscoverTimer = setTimeout(() => this.rediscover(), 2_000);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emitChange(): void {
		for (const listener of this.listeners) listener();
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
		this.logDebug("bridge.shutdown", { reason });
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
		const files = paths
			.map((path) => resolve(path))
			.filter((path) => isPathInside(this.workspaceRoot, path))
			.filter((path) => !shouldIgnorePath(this.workspaceRoot, path, this.excludePaths));
		this.logDebug("bridge.handleTouchedFiles", { reason, inputPaths: paths, files });
		if (files.some((file) => discoveryRelevantFile(toRelative(this.workspaceRoot, file)))) {
			this.scheduleRediscover();
		}
		const awaitedProviders = this.providers.filter(
			(provider) => provider.spec.kind === "lsp" || provider.spec.cli?.mode === "files",
		);
		const backgroundProviders = this.providers.filter(
			(provider) => provider.spec.kind === "cli" && provider.spec.cli?.mode === "workspace",
		);
		this.logDebug("bridge.handleTouchedFiles.providers", {
			awaited: awaitedProviders.map((provider) => provider.spec.id),
			background: backgroundProviders.map((provider) => provider.spec.id),
		});
		await Promise.all(awaitedProviders.map((provider) => provider.schedule(files, reason)));
		for (const provider of backgroundProviders) void provider.schedule(files, reason);
		const summaries: string[] = [];
		for (const file of files) {
			const relativePath = relative(this.workspaceRoot, file).replace(/\\/g, "/") || file;
			const summary = buildFileSummary(relativePath, this.store.getByFile(relativePath), 6);
			if (summary) summaries.push(summary);
		}
		if (summaries.length === 0) {
			this.logDebug("bridge.handleTouchedFiles.noSummary", { reason, files });
			return null;
		}
		const summary = summaries.join("\n\n");
		const digest = hashText(summary);
		if (digest === this.lastSurfacedSummaryDigest) {
			this.logDebug("bridge.handleTouchedFiles.duplicateSummary", { reason, files });
			return null;
		}
		this.lastSurfacedSummaryDigest = digest;
		this.logDebug("bridge.handleTouchedFiles.summary", { reason, files, summary });
		return summary;
	}

	buildPromptContext(): string | null {
		this.touchActivity();
		const diagnostics = this.store.getAll();
		if (diagnostics.length === 0) {
			this.logDebug("bridge.buildPromptContext.empty");
			return null;
		}
		const digest = JSON.stringify({ version: this.store.getVersion(), counts: this.store.getCounts(diagnostics) });
		if (digest === this.lastInjectionDigest && now() - this.lastInjectionAt < this.lifecycle.injectCooldownMs) {
			this.logDebug("bridge.buildPromptContext.cooldown", { injectCooldownMs: this.lifecycle.injectCooldownMs });
			return null;
		}
		this.lastInjectionDigest = digest;
		this.lastInjectionAt = now();
		this.logDebug("bridge.buildPromptContext.summary", { diagnostics: diagnostics.length });
		return buildPromptSummary(diagnostics, 8);
	}

	statusText(): string {
		const counts = formatStatusCounts(this.store.getCounts());
		const providerText = this.providers
			.map((provider) => ({ provider, status: provider.getStatus() }))
			.filter(({ status }) => status.state === "starting" || status.state === "running" || status.state === "cooldown")
			.map(({ provider, status }) => formatProviderStatus(provider.spec, status, this.statusSymbols))
			.join(" · ");
		const segments = [counts, providerText].filter((value): value is string => Boolean(value));
		return segments.length > 0 ? `lsp-bridge ${segments.join(" | ")}` : "lsp-bridge";
	}

	diagnosticsText(options?: { path?: string; providerId?: string; maxItems?: number }): string {
		const maxItems = options?.maxItems ?? 25;
		this.logDebug("bridge.diagnosticsText", { options, maxItems });
		if (options?.providerId) {
			const diagnostics = this.store.getByProvider(options.providerId);
			const summary = buildPromptSummary(diagnostics, maxItems);
			return summary ?? `No diagnostics for provider ${options.providerId}.`;
		}
		if (options?.path) {
			const normalized = options.path.replace(/^@/, "");
			const candidatePath = resolve(this.workspaceRoot, normalized);
			if (!isPathInside(this.workspaceRoot, candidatePath)) {
				return `Path is outside workspace: ${normalized}.`;
			}
			const relativePath = toRelative(this.workspaceRoot, candidatePath);
			const summary = buildFileSummary(relativePath, this.store.getByFile(relativePath), maxItems);
			return summary ?? `No diagnostics for ${relativePath}.`;
		}
		const diagnostics = this.store.getAll();
		const summary = buildPromptSummary(diagnostics, maxItems);
		return summary ?? "No current diagnostics.";
	}
}
