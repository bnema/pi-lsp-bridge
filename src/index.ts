import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { WorkspaceBridge } from "./runtime.js";
import { findWorkspaceRoot, isPathInside, shouldIgnorePath } from "./util.js";

type ContentBlock = { type: string; text?: string };

const EXTENSIONLESS_PATH_NAMES = new Set(["Makefile", "Dockerfile", "README", "LICENSE", "Procfile", "Gemfile", "Rakefile"]);

function extractTextContent(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function normalizePathCandidate(value: string): string {
	return value
		.trim()
		.replace(/^[\s"'`()\[]+/u, "")
		.replace(/[\s"'`),;\]]+$/u, "")
		.replace(/:\d+(?::\d+)?$/u, "");
}

function maybeAddFilePath(paths: Set<string>, rawCandidate: string, cwd: string, workspaceRoot: string): void {
	const candidate = normalizePathCandidate(rawCandidate);
	if (!candidate) return;
	const basename = candidate.split("/").pop() ?? candidate;
	if (!candidate.includes("/") && !candidate.startsWith(".") && !candidate.startsWith("@") && !candidate.includes(".") && !EXTENSIONLESS_PATH_NAMES.has(basename)) return;
	const pathValue = candidate.replace(/^@/, "");
	const absolute = resolve(pathValue.startsWith("/") ? pathValue : `${cwd}/${pathValue}`);
	if (!isPathInside(workspaceRoot, absolute) || shouldIgnorePath(workspaceRoot, absolute)) return;
	try {
		if (statSync(absolute).isFile()) paths.add(absolute);
	} catch {
		// ignore transient filesystem races
	}
}

function extractBashPaths(input: unknown, content: ContentBlock[] | undefined, cwd: string, workspaceRoot: string): string[] {
	if (!input || typeof input !== "object") return [];
	const command = typeof (input as { command?: unknown }).command === "string" ? (input as { command: string }).command : "";
	const output = extractTextContent(content);
	const paths = new Set<string>();
	for (const line of output.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const locationMatch = trimmed.match(/^([^:\s][^:]*?\.[^:\s]+):\d+(?::\d+)?:/u);
		if (locationMatch) {
			maybeAddFilePath(paths, locationMatch[1], cwd, workspaceRoot);
			continue;
		}
		maybeAddFilePath(paths, trimmed, cwd, workspaceRoot);
	}
	const tokenRegex = /"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s]+)/gu;
	for (const match of `${command}\n${output}`.matchAll(tokenRegex)) {
		const token = match[1] ?? match[2] ?? match[3] ?? match[4];
		if (token) maybeAddFilePath(paths, token, cwd, workspaceRoot);
	}
	return Array.from(paths);
}

function extractToolPaths(event: { toolName?: string; input?: unknown; content?: ContentBlock[] }, cwd: string, workspaceRoot: string): string[] {
	if (event.toolName === "bash") return extractBashPaths(event.input, event.content, cwd, workspaceRoot);
	if (!event.input || typeof event.input !== "object") return [];
	const rawPath = typeof (event.input as { path?: unknown }).path === "string" ? (event.input as { path: string }).path : undefined;
	if (!rawPath) return [];
	const normalized = rawPath.replace(/^@/, "");
	return [normalized.startsWith("/") ? normalized : `${cwd}/${normalized}`];
}

function surfaceDiagnosticsUpdate(pi: ExtensionAPI, summary: string): void {
	pi.sendMessage(
		{
			customType: "pi-lsp-bridge-diagnostics",
			content: `Background diagnostics update:\n${summary}`,
			display: true,
		},
		{ deliverAs: "steer" },
	);
}

type StatusContext = {
	hasUI: boolean;
	ui: {
		setStatus: (key: string, value: string | undefined) => void;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
	};
};
type BridgeContext = StatusContext & { sessionManager: { getSessionId: () => string } };

function applyStatus(bridge: WorkspaceBridge | undefined, ctx: StatusContext): void {
	if (!bridge || !ctx.hasUI) return;
	ctx.ui.setStatus("pi-lsp-bridge", bridge.statusText());
}

export default function (pi: ExtensionAPI) {
	let bridge: WorkspaceBridge | undefined;
	let latestStatusContext: StatusContext | undefined;
	let unsubscribeStatus: (() => void) | undefined;
	let lastDebugLogNotification: string | undefined;

	function maybeNotifyDebugLog(current: WorkspaceBridge, ctx: StatusContext): void {
		const debugLogPath = current.getDebugLogPath();
		if (!ctx.hasUI || !debugLogPath || debugLogPath === lastDebugLogNotification) return;
		lastDebugLogNotification = debugLogPath;
		ctx.ui.notify(`pi-lsp-bridge debug log: ${debugLogPath}`, "info");
	}

	function bindStatus(current: WorkspaceBridge, ctx: StatusContext): void {
		latestStatusContext = ctx;
		maybeNotifyDebugLog(current, ctx);
		if (bridge !== current || !unsubscribeStatus) {
			unsubscribeStatus?.();
			unsubscribeStatus = current.subscribe(() => {
				if (latestStatusContext) applyStatus(current, latestStatusContext);
			});
		}
		applyStatus(current, ctx);
	}

	function ensureBridge(cwd: string, ctx?: BridgeContext): WorkspaceBridge {
		const workspaceRoot = findWorkspaceRoot(cwd);
		if (!bridge || bridge.workspaceRoot !== workspaceRoot) {
			unsubscribeStatus?.();
			unsubscribeStatus = undefined;
			bridge = WorkspaceBridge.create(workspaceRoot, { sessionId: ctx?.sessionManager.getSessionId() });
		}
		if (ctx) bindStatus(bridge, ctx);
		return bridge;
	}

	async function restartBridge(ctx: ExtensionCommandContext): Promise<void> {
		if (bridge) await bridge.shutdown("reload");
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		bridge = WorkspaceBridge.create(findWorkspaceRoot(ctx.cwd), { sessionId: ctx.sessionManager.getSessionId() });
		bridge.logDebug("index.restartBridge", { cwd: ctx.cwd });
		bindStatus(bridge, ctx);
	}

	pi.registerCommand("lsp-status", {
		description: "Show current background diagnostics bridge status",
		handler: async (_args, ctx) => {
			const current = ensureBridge(ctx.cwd, ctx);
			ctx.ui.notify(current.statusText(), "info");
		},
	});

	pi.registerCommand("lsp-restart", {
		description: "Restart the background diagnostics bridge",
		handler: async (_args, ctx) => {
			await restartBridge(ctx);
			ctx.ui.notify("pi-lsp-bridge restarted", "info");
		},
	});

	pi.registerTool({
		name: "diagnostics",
		label: "Diagnostics",
		description: "Inspect current merged background diagnostics from active LSP and linter providers.",
		promptSnippet: "Inspect merged project or file diagnostics collected in the background.",
		promptGuidelines: [
			"Use diagnostics when you need the latest background errors, warnings, or linter issues before deciding on edits.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Optional project-relative path to inspect" })),
			providerId: Type.Optional(Type.String({ description: "Optional provider id to filter by" })),
			maxItems: Type.Optional(Type.Number({ description: "Maximum diagnostics to show", minimum: 1, maximum: 100 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = ensureBridge(ctx.cwd, ctx);
			const text = current.diagnosticsText({
				path: params.path,
				providerId: params.providerId,
				maxItems: params.maxItems,
			});
			applyStatus(current, ctx);
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		bridge = WorkspaceBridge.create(findWorkspaceRoot(ctx.cwd), { sessionId: ctx.sessionManager.getSessionId() });
		bridge.logDebug("index.session_start", { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
		bindStatus(bridge, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = ensureBridge(ctx.cwd, ctx);
		current.logDebug("index.before_agent_start", { cwd: ctx.cwd });
		const summary = current.buildPromptContext();
		if (!summary) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${summary}\n\nUse the diagnostics tool if you need a fuller, current snapshot.`,
		};
	});

	pi.on("tool_call" as any, async (event: any, ctx: any) => {
		const current = ensureBridge(ctx.cwd, ctx);
		current.logDebug("index.tool_call", { toolName: event.toolName, cwd: ctx.cwd, input: event.input });
	});

	pi.on("tool_result" as any, async (event: any, ctx: any) => {
		if (!["read", "edit", "write", "bash"].includes(event.toolName)) return;
		if (event.toolName !== "bash" && event.isError) return;
		const current = ensureBridge(ctx.cwd, ctx);
		const paths = extractToolPaths(event, ctx.cwd, current.workspaceRoot);
		current.logDebug("index.tool_result", {
			toolName: event.toolName,
			isError: event.isError,
			cwd: ctx.cwd,
			paths,
		});
		if (paths.length === 0) return;
		const reason = event.toolName === "bash" ? "bash" : event.toolName;
		const summary = await current.handleTouchedFiles(paths, reason as "bash" | "read" | "edit" | "write");
		applyStatus(current, ctx);
		if (!summary) return;
		current.logDebug("index.surfaceDiagnosticsUpdate", { toolName: event.toolName, summary });
		surfaceDiagnosticsUpdate(pi, summary);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		bridge?.logDebug("index.session_shutdown", { cwd: ctx.cwd });
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		latestStatusContext = undefined;
		if (bridge) {
			await bridge.shutdown("shutdown");
			bridge = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus("pi-lsp-bridge", undefined);
	});
}
