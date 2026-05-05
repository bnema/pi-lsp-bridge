import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { findWorkspaceRoot } from "../src/util.js";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-lsp-bridge-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("findWorkspaceRoot returns null outside a git repository", () => {
	withTempDir((dir) => {
		assert.equal(findWorkspaceRoot(dir), null);
	});
});

test("findWorkspaceRoot returns the nearest ancestor git repository", () => {
	withTempDir((dir) => {
		const repo = join(dir, "repo");
		const nested = join(repo, "packages", "api");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		assert.equal(findWorkspaceRoot(nested), repo);
	});
});
