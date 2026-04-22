import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { WorkspaceBridge } from "./runtime.js";
import { findWorkspaceRoot } from "./util.js";

function appendTextContent(content: Array<{ type: string; text?: string }>, text: string) {
	return [...content, { type: "text", text }];
}

function extractToolPaths(input: unknown, cwd: string): string[] {
	if (!input || typeof input !== "object") return [];
	const rawPath = typeof (input as { path?: unknown }).path === "string" ? (input as { path: string }).path : undefined;
	if (!rawPath) return [];
	const normalized = rawPath.replace(/^@/, "");
	return [normalized.startsWith("/") ? normalized : `${cwd}/${normalized}`];
}

type StatusContext = { hasUI: boolean; ui: { setStatus: (key: string, value: string | undefined) => void } };

function applyStatus(bridge: WorkspaceBridge | undefined, ctx: StatusContext): void {
	if (!bridge || !ctx.hasUI) return;
	ctx.ui.setStatus("pi-lsp-bridge", bridge.statusText());
}

export default function (pi: ExtensionAPI) {
	let bridge: WorkspaceBridge | undefined;
	let latestStatusContext: StatusContext | undefined;
	let unsubscribeStatus: (() => void) | undefined;

	function bindStatus(current: WorkspaceBridge, ctx: StatusContext): void {
		latestStatusContext = ctx;
		if (bridge !== current || !unsubscribeStatus) {
			unsubscribeStatus?.();
			unsubscribeStatus = current.subscribe(() => {
				if (latestStatusContext) applyStatus(current, latestStatusContext);
			});
		}
		applyStatus(current, ctx);
	}

	function ensureBridge(cwd: string, ctx?: StatusContext): WorkspaceBridge {
		const workspaceRoot = findWorkspaceRoot(cwd);
		if (!bridge || bridge.workspaceRoot !== workspaceRoot) {
			unsubscribeStatus?.();
			unsubscribeStatus = undefined;
			bridge = WorkspaceBridge.create(workspaceRoot);
		}
		if (ctx) bindStatus(bridge, ctx);
		return bridge;
	}

	async function restartBridge(ctx: ExtensionCommandContext): Promise<void> {
		if (bridge) await bridge.shutdown("reload");
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		bridge = WorkspaceBridge.create(findWorkspaceRoot(ctx.cwd));
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
		bridge = WorkspaceBridge.create(findWorkspaceRoot(ctx.cwd));
		bindStatus(bridge, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = ensureBridge(ctx.cwd, ctx);
		const summary = current.buildPromptContext();
		if (!summary) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${summary}\n\nUse the diagnostics tool if you need a fuller, current snapshot.`,
		};
	});

	pi.on("tool_result" as any, async (event: any, ctx: any) => {
		if (!["read", "edit", "write"].includes(event.toolName) || event.isError) return;
		const current = ensureBridge(ctx.cwd, ctx);
		const paths = extractToolPaths(event.input, ctx.cwd);
		if (paths.length === 0) return;
		const summary = await current.handleTouchedFiles(paths, event.toolName as "read" | "edit" | "write");
		applyStatus(current, ctx);
		if (!summary) return;
		return {
			content: appendTextContent(
				event.content as Array<{ type: string; text?: string }>,
				`\nBackground diagnostics update:\n${summary}`,
			),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
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
