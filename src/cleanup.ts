import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashPath, now } from "./util.js";

interface RegistryEntry {
	ownerPid: number;
	workspaceRoot: string;
	updatedAt: number;
	children: Array<{ providerId: string; pid: number; pgid?: number }>;
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killProcess(pid: number, pgid?: number): void {
	try {
		if (pgid && process.platform !== "win32") {
			process.kill(-pgid, "SIGKILL");
			return;
		}
		process.kill(pid, "SIGKILL");
	} catch {
		// Ignore best-effort cleanup failures.
	}
}

export class CleanupRegistry {
	private readonly dir: string;
	private readonly file: string;
	private readonly workspaceRoot: string;
	private readonly ownerPid: number;
	private children = new Map<string, { pid: number; pgid?: number }>();

	constructor(workspaceRoot: string, maxAgeMs: number) {
		this.dir = join(tmpdir(), "pi-lsp-bridge");
		this.file = join(this.dir, `${hashPath(workspaceRoot)}.json`);
		this.workspaceRoot = workspaceRoot;
		this.ownerPid = process.pid;
		mkdirSync(this.dir, { recursive: true });
		CleanupRegistry.sweep(this.dir, maxAgeMs);
		this.flush();
	}

	register(providerId: string, pid: number, pgid?: number): void {
		if (pid <= 0) return;
		this.children.set(providerId, { pid, pgid });
		this.flush();
	}

	unregister(providerId: string): void {
		if (!this.children.delete(providerId)) return;
		this.flush();
	}

	dispose(): void {
		for (const [providerId] of this.children) this.unregister(providerId);
		try {
			rmSync(this.file, { force: true });
		} catch {
			// ignore
		}
	}

	private flush(): void {
		const entry: RegistryEntry = {
			ownerPid: this.ownerPid,
			workspaceRoot: this.workspaceRoot,
			updatedAt: now(),
			children: Array.from(this.children.entries()).map(([providerId, value]) => ({ providerId, ...value })),
		};
		writeFileSync(this.file, JSON.stringify(entry, null, 2));
	}

	static sweep(dir: string, maxAgeMs: number): void {
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".json"));
		} catch {
			return;
		}
		for (const file of files) {
			const full = join(dir, file);
			let entry: RegistryEntry | null = null;
			try {
				entry = JSON.parse(readFileSync(full, "utf8")) as RegistryEntry;
			} catch {
				rmSync(full, { force: true });
				continue;
			}
			const stale = now() - entry.updatedAt > maxAgeMs;
			const ownerAlive = pidExists(entry.ownerPid);
			if (ownerAlive && !stale) continue;
			for (const child of entry.children) killProcess(child.pid, child.pgid);
			rmSync(full, { force: true });
		}
	}
}
