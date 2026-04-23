import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

export interface SessionLogger {
	enabled: boolean;
	logger: Logger;
	filePath?: string;
}

function getStateRoot(): string {
	const stateHome = process.env.XDG_STATE_HOME?.trim();
	return stateHome && stateHome.length > 0 ? stateHome : join(homedir(), ".local", "state");
}

export function createSessionLogger(options: {
	enabled: boolean;
	sessionId?: string;
	workspaceRoot: string;
}): SessionLogger {
	if (!options.enabled) {
		return {
			enabled: false,
			logger: pino({ level: "silent" }),
		};
	}

	const requestedSessionId = options.sessionId?.trim() || `ephemeral-${process.pid}`;
	const sessionId = requestedSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || `ephemeral-${process.pid}`;
	const dir = join(getStateRoot(), "pi-lsp-bridge");
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, `${sessionId}.log`);
	const destination = pino.destination({ dest: filePath, sync: false });
	destination.on("error", (error) => {
		console.error(`pi-lsp-bridge: failed writing debug log ${filePath}`, error);
	});
	const logger = pino(
		{
			level: "debug",
			base: {
				sessionId,
				workspaceRoot: options.workspaceRoot,
				pid: process.pid,
			},
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		destination,
	);
	logger.info({ filePath }, "pi-lsp-bridge debug logging enabled");
	return {
		enabled: true,
		logger,
		filePath,
	};
}
