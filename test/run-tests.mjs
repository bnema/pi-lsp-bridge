import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(projectRoot, ".tmp", "test-dist");

function readPositiveMs(name, defaultValue) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return defaultValue;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive millisecond value; got ${JSON.stringify(raw)}.`);
	}
	return Math.ceil(value);
}

const killAfterMs = readPositiveMs("TEST_KILL_AFTER_MS", 5_000);
const tscTimeoutMs = readPositiveMs("TSC_TIMEOUT_MS", 30_000);
const testTimeoutMs = readPositiveMs("TEST_TIMEOUT_MS", 15_000);
const nodeTestTimeoutMs = readPositiveMs("NODE_TEST_TIMEOUT_MS", 5_000);

function collectTestFiles(dir) {
	const files = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectTestFiles(fullPath));
		else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(fullPath);
	}
	return files.sort();
}

function run(command, args, { timeoutMs, label }) {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit" });
		let finished = false;
		let timedOut = false;
		let killTimer;
		const timeoutTimer = setTimeout(() => {
			if (finished) return;
			timedOut = true;
			console.error(`${label} timed out after ${timeoutMs}ms; terminating process ${child.pid}.`);
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!finished) child.kill("SIGKILL");
			}, killAfterMs);
		}, timeoutMs);

		child.once("error", (error) => {
			finished = true;
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			rejectRun(timedOut ? new Error(`${label} timed out after ${timeoutMs}ms.`) : error);
		});

		child.once("exit", (code, signal) => {
			finished = true;
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			if (timedOut) {
				rejectRun(new Error(`${label} timed out after ${timeoutMs}ms${signal ? ` and exited with signal ${signal}` : ""}.`));
				return;
			}
			if (code === 0) {
				resolveRun();
				return;
			}
			rejectRun(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
		});
	});
}

rmSync(outDir, { recursive: true, force: true });
await run(process.execPath, [join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"], {
	timeoutMs: tscTimeoutMs,
	label: "TypeScript test compile",
});

const testDir = join(outDir, "test");
const testFiles = collectTestFiles(testDir);
if (testFiles.length === 0) throw new Error(`No compiled test files found under ${testDir}.`);

await run(process.execPath, ["--test", `--test-timeout=${nodeTestTimeoutMs}`, ...testFiles], {
	timeoutMs: testTimeoutMs,
	label: "Node test runner",
});
