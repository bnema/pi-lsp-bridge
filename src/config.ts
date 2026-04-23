import { join } from "node:path";
import { DEFAULT_PROVIDER_SPECS, findDefaultProviderById, findDefaultProviderForLanguageId } from "./default-registry.js";
import type {
	BridgeLifecycleConfig,
	LoadedConfig,
	ProviderOverride,
	ProviderSpec,
	RepoConfig,
	StatusSymbolsMode,
	WorkspaceInventory,
} from "./types.js";
import { readJsonFile } from "./util.js";

export const DEFAULT_LIFECYCLE: BridgeLifecycleConfig = {
	lspDebounceMs: 500,
	cliDebounceMs: 1200,
	cliWorkspaceDebounceMs: 2500,
	injectCooldownMs: 10_000,
	idleSuspendMs: 10 * 60_000,
	triggerCooldownMs: 350,
	maxOpenDocuments: 32,
	maxFileBytes: 1024 * 1024,
	bootstrapSampleFiles: 5,
	orphanSweepMaxAgeMs: 24 * 60 * 60_000,
};

function normalizeStatusSymbols(value: string | undefined): StatusSymbolsMode | undefined {
	switch (value?.trim().toLowerCase()) {
		case "nerdfont":
		case "nf":
		case "icon":
		case "icons":
		case "on":
		case "true":
		case "1":
			return "nerdfont";
		case "text":
		case "plain":
		case "ascii":
		case "off":
		case "false":
		case "0":
			return "text";
		default:
			return undefined;
	}
}

function normalizeBoolean(value: string | undefined): boolean | undefined {
	switch (value?.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function mergeProviderSpec(base: ProviderSpec, override: ProviderOverride): ProviderSpec {
	const commandCandidates = override.command
		? [{ command: override.command, args: override.args ?? [] }]
		: override.commandCandidates ?? base.commandCandidates;
	return {
		...base,
		...override,
		commandCandidates,
		selectors: override.selectors ?? base.selectors,
		detect: override.detect ?? base.detect,
		lsp: override.lsp ?? base.lsp,
		cli: override.cli ?? base.cli,
	};
}

function opencodeOverrides(workspaceRoot: string): ProviderOverride[] {
	const opencode = readJsonFile<{ lsp?: Record<string, { disabled?: boolean; command?: string; args?: string[] }> }>(
		join(workspaceRoot, ".opencode.json"),
	);
	const overrides: ProviderOverride[] = [];
	for (const [languageId, config] of Object.entries(opencode?.lsp ?? {})) {
		const matched = findDefaultProviderForLanguageId(languageId);
		if (!matched) continue;
		overrides.push({
			id: matched.id,
			disabled: config.disabled,
			command: config.command,
			args: config.args,
		});
	}
	return overrides;
}

export function loadConfig(workspaceRoot: string): LoadedConfig {
	const repoConfig =
		readJsonFile<RepoConfig>(join(workspaceRoot, ".pi", "lsp-bridge.json")) ??
		readJsonFile<RepoConfig>(join(workspaceRoot, "pi-lsp-bridge.json")) ??
		{};
	const lifecycle: BridgeLifecycleConfig = {
		...DEFAULT_LIFECYCLE,
		...(repoConfig.lifecycle ?? {}),
	};
	const opencode = opencodeOverrides(workspaceRoot);
	const status = {
		symbols:
			normalizeStatusSymbols(process.env.PI_LSP_BRIDGE_STATUS_SYMBOLS) ??
			normalizeStatusSymbols(repoConfig.status?.symbols) ??
			"nerdfont",
	} as const;
	return {
		repoConfig,
		opencodeOverrides: opencode,
		lifecycle,
		debug: normalizeBoolean(process.env.PI_LSP_BRIDGE_DEBUG) ?? repoConfig.debug === true,
		status,
	};
}

function inventoryHasRepoFile(inventory: WorkspaceInventory, names?: string[]): boolean {
	return names?.some((name) => inventory.basenames.has(name)) ?? false;
}

function inventoryHasExtension(inventory: WorkspaceInventory, extensions?: string[]): boolean {
	return extensions?.some((extension) => inventory.extensions.has(extension)) ?? false;
}

function inventoryHasDependency(inventory: WorkspaceInventory, dependencies?: string[]): boolean {
	return dependencies?.some((dependency) => inventory.packageJsonDeps.has(dependency)) ?? false;
}

function inventoryHasSelectorMatch(spec: ProviderSpec, inventory: WorkspaceInventory): boolean {
	return spec.selectors?.some((selector) => selector.extensions?.some((extension) => inventory.extensions.has(extension)) ?? false) ?? false;
}

export function providerHasStrongSignal(spec: ProviderSpec, inventory: WorkspaceInventory): boolean {
	const detection = spec.detect;
	return (
		inventoryHasRepoFile(inventory, detection?.repoFilesAny) ||
		inventoryHasRepoFile(inventory, detection?.configFilesAny) ||
		inventoryHasDependency(inventory, detection?.packageJsonDepsAny) ||
		inventoryHasRepoFile(inventory, spec.rootMarkers) ||
		inventoryHasRepoFile(inventory, spec.configMarkers)
	);
}

export function shouldAutostartProvider(spec: ProviderSpec, inventory: WorkspaceInventory): boolean {
	if (spec.kind === "cli") return spec.cli?.runOnStartup === true;
	return providerHasStrongSignal(spec, inventory);
}

function providerMatchesInventory(spec: ProviderSpec, inventory: WorkspaceInventory): boolean {
	const detection = spec.detect;
	return (
		providerHasStrongSignal(spec, inventory) ||
		inventoryHasExtension(inventory, detection?.fileExtensionsAny) ||
		inventoryHasSelectorMatch(spec, inventory)
	);
}

export function selectProviders(inventory: WorkspaceInventory, loaded: LoadedConfig): ProviderSpec[] {
	const map = new Map<string, ProviderSpec>();
	for (const provider of DEFAULT_PROVIDER_SPECS) map.set(provider.id, provider);
	for (const override of loaded.opencodeOverrides) {
		const existing = map.get(override.id);
		if (existing) map.set(override.id, mergeProviderSpec(existing, override));
	}

	const explicit: ProviderSpec[] = [];
	for (const entry of loaded.repoConfig.providers ?? []) {
		if (typeof entry === "string") {
			const provider = findDefaultProviderById(entry);
			if (provider) explicit.push(provider);
			continue;
		}
		const base = findDefaultProviderById(entry.id);
		if (base) {
			explicit.push(mergeProviderSpec(base, entry));
			map.set(entry.id, mergeProviderSpec(base, entry));
		} else if (entry.kind && ((entry.kind === "lsp" && entry.command) || (entry.kind === "cli" && entry.command))) {
			explicit.push({
				id: entry.id,
				kind: entry.kind,
				role: entry.role ?? (entry.kind === "lsp" ? "primary" : "supplemental"),
				priority: entry.priority ?? 500,
				selectors: entry.selectors,
				detect: entry.detect,
				rootMarkers: entry.rootMarkers,
				configMarkers: entry.configMarkers,
				commandCandidates: [{ command: entry.command, args: entry.args ?? [] }],
				lsp: entry.lsp,
				cli: entry.cli,
				description: entry.description,
				disabled: entry.disabled,
				family: entry.family,
			});
		}
	}

	const autoDetected = loaded.repoConfig.autoDetect !== false ? Array.from(map.values()) : [];
	const combined = [...explicit, ...autoDetected].filter((provider, index, all) => all.findIndex((candidate) => candidate.id === provider.id) === index);
	const matched = combined.filter((provider) => !provider.disabled && providerMatchesInventory(provider, inventory));

	const familyWinner = new Map<string, ProviderSpec>();
	const result: ProviderSpec[] = [];
	for (const provider of matched.sort((left, right) => left.priority - right.priority)) {
		if (provider.role !== "primary" || !provider.family) {
			result.push(provider);
			continue;
		}
		const current = familyWinner.get(provider.family);
		if (!current || provider.priority < current.priority) {
			familyWinner.set(provider.family, provider);
		}
	}
	const primaryIds = new Set(Array.from(familyWinner.values()).map((provider) => provider.id));
	for (const provider of matched.sort((left, right) => left.priority - right.priority)) {
		if (provider.role === "primary") {
			if (primaryIds.has(provider.id)) result.push(provider);
			continue;
		}
		if (!result.some((candidate) => candidate.id === provider.id)) result.push(provider);
	}
	return result;
}
