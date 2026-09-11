import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { getCatalogCachePath, getCredentialFingerprint, loadCatalogCache, saveCatalogCache } from "../src/cache.js";

const cachedModel: Model<"openai-responses"> = {
  id: "gpt-5.6-sol-fast",
  name: "GPT-5.6 Sol Fast",
  api: "openai-responses",
  provider: "github-copilot",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

test("uses pi's resolved agent directory for the catalog cache", () => {
  const agentDir = resolve(tmpdir(), "pi-agent");
  assert.equal(getCatalogCachePath(agentDir), join(agentDir, "dynamic-copilot-models.json"));
  assert.throws(() => getCatalogCachePath("~/.pi-sdk"), /absolute agentDir/);
  assert.throws(() => getCatalogCachePath("relative/pi-sdk"), /absolute agentDir/);
});

test("fingerprints stable account credentials without exposing them", () => {
  const first = getCredentialFingerprint({ type: "oauth", refresh: "account-a", access: "short-lived-a" });
  const refreshed = getCredentialFingerprint({ type: "oauth", refresh: "account-a", access: "short-lived-b" });
  const other = getCredentialFingerprint({ type: "oauth", refresh: "account-b", access: "short-lived-c" });
  assert.equal(first, refreshed);
  assert.notEqual(first, other);
  assert.equal(first?.includes("account-a"), false);
  assert.notEqual(getCredentialFingerprint({ type: "api_key", key: "environment-token" }), undefined);
  assert.equal(getCredentialFingerprint({ type: "oauth", access: "missing-refresh" }), undefined);
});

test("round-trips a dynamic catalog only for the matching account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  const otherAccount = getCredentialFingerprint({ type: "oauth", refresh: "account-b" });
  try {
    await saveCatalogCache([cachedModel], account, path);
    assert.deepEqual(loadCatalogCache(account, path), [cachedModel]);
    assert.equal(loadCatalogCache(otherAccount, path), undefined);
    assert.equal(loadCatalogCache(undefined, path), undefined);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed, empty, and foreign-provider caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dynamic-copilot-cache-"));
  const path = join(directory, "catalog.json");
  const account = getCredentialFingerprint({ type: "oauth", refresh: "account-a" });
  try {
    assert.equal(loadCatalogCache(account, path), undefined);
    for (const payload of [
      "not json",
      JSON.stringify({ version: 2, credentialFingerprint: account, models: [] }),
      JSON.stringify({ version: 2, credentialFingerprint: account, models: [{ ...cachedModel, provider: "openai" }] }),
      JSON.stringify({ version: 1, credentialFingerprint: account, models: [cachedModel] }),
    ]) {
      await writeFile(path, payload);
      assert.equal(loadCatalogCache(account, path), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
