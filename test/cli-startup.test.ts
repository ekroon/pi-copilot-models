import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { getCredentialFingerprint, saveCatalogCache } from "../src/cache.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("real CLI startup preserves the thinking flag and suffix through catalog refresh", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-copilot-cli-"));
  const credential = { type: "api_key", key: "test-cli-credential" };
  const selected: Model<"openai-responses"> = {
    id: "gpt-cli-test", name: "CLI test", provider: "github-copilot", api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com", reasoning: true, input: ["text"],
    contextWindow: 128_000, maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  try {
    await saveCatalogCache({
      models: [selected],
      routes: new Map([[selected.id, { canonicalModelId: selected.id, contextTier: "default" }]]),
    }, getCredentialFingerprint(credential), join(directory, "dynamic-copilot-models.json"));
    await writeFile(join(directory, "auth.json"), JSON.stringify({ "github-copilot": credential }));
    await writeFile(join(directory, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    const preload = join(directory, "no-network.mjs");
    // Pi configures its own Fetch implementation. Guard the socket layer too,
    // so a broken test fixture can never send a credential to a real endpoint.
    await writeFile(preload, `import { Socket } from "node:net";
      Socket.prototype.connect = function() { throw new Error("Unexpected test network access"); };`);
    const probe = join(directory, "probe.ts");
    await writeFile(probe, `export default function(pi) {
      pi.on("session_start", () => {
        globalThis.fetch = async (input) => {
          const url = String(input instanceof Request ? input.url : input);
          if (!url.endsWith("/models")) throw new Error("Unexpected test fetch: " + url);
          return new Response(JSON.stringify({ data: [{
            id: "gpt-cli-test", name: "CLI test refreshed", model_picker_enabled: true,
            policy: { state: "enabled" }, capabilities: {
              limits: { max_context_window_tokens: 256000, max_output_tokens: 16384 },
              supports: { tool_calls: true, reasoning_effort: ["none", "low", "medium", "high"] }
            }
          }] }), { status: 200 });
        };
      });
      pi.registerCommand("test-thinking", { description: "Test probe", handler: async (_args, ctx) => {
        console.log("THINKING_STATE=" + JSON.stringify({ level: pi.getThinkingLevel(), id: ctx.model?.id, window: ctx.model?.contextWindow }));
      } });
    }`);
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "../package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const cli = process.env.PI_TEST_CLI ?? join(dirname(manifestPath), manifest.bin.pi);
    const cases = [
      { args: ["--model", `github-copilot/${selected.id}`, "--thinking", "high"], level: "high" },
      { args: ["--model", `github-copilot/${selected.id}:high`], level: "high" },
      { args: ["--model", `github-copilot/${selected.id}:high`, "--thinking", "off"], level: "off" },
    ];
    for (const { args, level } of cases) {
      const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: directory, COPILOT_GITHUB_TOKEN: "" };
      delete env.PI_OFFLINE;
      const child = exec(process.execPath, [
        "--import", preload, cli,
        "--no-extensions", "-e", probe, "-e", join(root, "extensions/dynamic-copilot-models.ts"),
        "--no-skills", "--no-prompt-templates", "--no-session", ...args, "-p", "/test-thinking",
      ], { cwd: directory, env, timeout: 15_000 });
      child.child.stdin?.end();
      const { stdout, stderr } = await child;
      assert.doesNotMatch(stderr, /Failed to load extension|Extension error|discovery failed/);
      const state = `${stdout}\n${stderr}`.match(/THINKING_STATE=(.+)/)?.[1];
      assert.ok(state, `CLI probe missing: ${stdout}\n${stderr}`);
      assert.deepEqual(JSON.parse(state), { level, id: selected.id, window: 256_000 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
