export type DiagnosticSeverityName = "error" | "warning" | "info" | "hint";
export type ProviderKind = "lsp" | "cli";
export type ProviderRole = "primary" | "supplemental";
export type TriggerReason =
	| "startup"
	| "read"
	| "edit"
	| "write"
	| "config-change"
	| "manual"
	| "prompt"
	| "resume";

export interface FileSelector {
	languageId: string;
	extensions?: string[];
	filenames?: string[];
}

export interface ProviderDetection {
	repoFilesAny?: string[];
	configFilesAny?: string[];
	packageJsonDepsAny?: string[];
	fileExtensionsAny?: string[];
}

export interface CommandCandidate {
	command: string;
	args?: string[];
}

export interface LspProviderOptions {
	initializationOptions?: Record<string, unknown>;
}

export interface CliProviderOptions {
	parser: "eslint-json" | "golangci-lint-json" | "ruff-json" | "sarif";
	mode: "files" | "workspace";
	runOnStartup?: boolean;
	runOnChange?: boolean;
}

export interface ProviderSpec {
	id: string;
	kind: ProviderKind;
	role: ProviderRole;
	family?: string;
	priority: number;
	description?: string;
	detect?: ProviderDetection;
	selectors?: FileSelector[];
	rootMarkers?: string[];
	configMarkers?: string[];
	commandCandidates: CommandCandidate[];
	lsp?: LspProviderOptions;
	cli?: CliProviderOptions;
	disabled?: boolean;
}

export interface ProviderOverride extends Partial<Omit<ProviderSpec, "id">> {
	id: string;
	command?: string;
	args?: string[];
}

export interface BridgeLifecycleConfig {
	lspDebounceMs: number;
	cliDebounceMs: number;
	cliWorkspaceDebounceMs: number;
	injectCooldownMs: number;
	idleSuspendMs: number;
	triggerCooldownMs: number;
	maxOpenDocuments: number;
	maxFileBytes: number;
	bootstrapSampleFiles: number;
	orphanSweepMaxAgeMs: number;
}

export type StatusSymbolsMode = "nerdfont" | "text";

export interface StatusConfig {
	symbols?: StatusSymbolsMode;
}

export interface RepoConfig {
	autoDetect?: boolean;
	debug?: boolean;
	excludePaths?: string[];
	lifecycle?: Partial<BridgeLifecycleConfig>;
	providers?: Array<string | ProviderOverride>;
	status?: StatusConfig;
}

export interface LoadedConfig {
	repoConfig: RepoConfig;
	opencodeOverrides: ProviderOverride[];
	lifecycle: BridgeLifecycleConfig;
	debug: boolean;
	status: Required<StatusConfig>;
}

export interface WorkspaceInventory {
	files: string[];
	basenames: Set<string>;
	extensions: Set<string>;
	packageJsonDeps: Set<string>;
}

export interface ResolvedCommand {
	command: string;
	args: string[];
}

export interface RangePosition {
	line: number;
	character: number;
}

export interface UnifiedRange {
	start: RangePosition;
	end: RangePosition;
}

export interface UnifiedDiagnostic {
	id: string;
	providerId: string;
	sourceKind: ProviderKind;
	filePath: string;
	severity: DiagnosticSeverityName;
	message: string;
	code?: string;
	range?: UnifiedRange;
	tags?: Array<"deprecated" | "unnecessary">;
	observedAt: number;
}

export interface DiagnosticsCounts {
	error: number;
	warning: number;
	info: number;
	hint: number;
}

export interface ProviderStatus {
	state: "stopped" | "starting" | "running" | "cooldown" | "backoff" | "missing" | "disabled";
	lastRunAt?: number;
	backoffUntil?: number;
	message?: string;
}

export interface ProviderRuntime {
	spec: ProviderSpec;
	getStatus(): ProviderStatus;
	schedule(files: string[], reason: TriggerReason): Promise<void>;
	suspend(reason: "idle" | "shutdown" | "reload"): Promise<void>;
}
