import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPromptWithDiagnosticsContext } from "../src/index.js";

const basePrompt = "Base system prompt.";
const summary = "Current diagnostics for touched files: 1 error.\n- ERROR: src/app.ts:1:1 boom";
const guidance = "Use the diagnostics tool if you need a fuller, current snapshot.";

test("buildSystemPromptWithDiagnosticsContext preserves guidance when selectedTools is absent", () => {
	const prompt = buildSystemPromptWithDiagnosticsContext(basePrompt, summary, undefined);

	assert.ok(prompt.includes(summary));
	assert.ok(prompt.includes(guidance));
});

test("buildSystemPromptWithDiagnosticsContext includes guidance when diagnostics tool is selected", () => {
	const prompt = buildSystemPromptWithDiagnosticsContext(basePrompt, summary, ["read", "diagnostics"]);

	assert.ok(prompt.includes(summary));
	assert.ok(prompt.includes(guidance));
});

test("buildSystemPromptWithDiagnosticsContext omits diagnostics-tool guidance when diagnostics tool is not selected", () => {
	const prompt = buildSystemPromptWithDiagnosticsContext(basePrompt, summary, ["read", "bash"]);

	assert.ok(prompt.includes(summary));
	assert.ok(!prompt.includes(guidance));
});

test("buildSystemPromptWithDiagnosticsContext preserves guidance when selectedTools shape is unknown", () => {
	const prompt = buildSystemPromptWithDiagnosticsContext(basePrompt, summary, { diagnostics: true });

	assert.ok(prompt.includes(summary));
	assert.ok(prompt.includes(guidance));
});
