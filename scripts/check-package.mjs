import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "pi-copilot-package-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
try {
  const agentDir = join(temporary, "agent");
  const cwd = join(temporary, "workspace");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Packaging/loading must not need credentials or reach a service.
  globalThis.fetch = async () => { throw new Error("Unexpected network access in package smoke test"); };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [packed] = JSON.parse(execFileSync(npm, [
    "pack", "--ignore-scripts", "--json", "--pack-destination", temporary,
  ], { cwd: root, encoding: "utf8" }));
  const paths = packed.files.map((entry) => entry.path);
  assert.ok(paths.includes("extensions/dynamic-copilot-models.ts"));
  for (const path of paths) {
    assert.match(path, /^(?:package\.json|README\.md|CHANGELOG\.md|SECURITY\.md|LICENSE|(?:src|extensions|docs)\/[^.].*)$/);
    assert.doesNotMatch(path, /(?:^|\/)(?:node_modules|auth\.json|\.env|plans|todos|test)(?:\/|$)/);
  }
  execFileSync("tar", ["-xzf", join(temporary, packed.filename), "-C", temporary]);
  const packageRoot = join(temporary, "package");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, packed.version);

  // Load the extracted package without a local node_modules, just as a Pi
  // git/npm install does. This exercises Pi's host-package aliases and jiti's
  // resolution of the shipped TypeScript modules and .js import specifiers.
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd, agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: manifest.pi.extensions.map((path) => join(packageRoot, path)),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("copilot-models-refresh"));
  const providers = loaded.runtime.pendingNativeProviderRegistrations;
  assert.equal(providers.length, 1);
  assert.equal(providers[0].provider.id, "github-copilot");
  assert.ok(providers[0].provider.getModels().length > 0);
  console.log(`Package smoke test passed: ${packed.name}@${packed.version}, ${paths.length} shipped files`);
} finally {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(temporary, { recursive: true, force: true });
}
