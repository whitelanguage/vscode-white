const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const { dirname, resolve } = require("node:path");
const { buildSync } = require("esbuild");

const source = resolve(__dirname, "..", "src", "releaseTags.ts");
const output = buildSync({
  entryPoints: [source],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
}).outputFiles[0].text;
const loaded = new Module(source);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(dirname(source));
loaded._compile(output, source);

const { isNewerReleaseTag, latestReleaseTag } = loaded.exports;

test("selects the newest numeric v* tag", () => {
  const refs = [
    "a\trefs/tags/v0.1",
    "b\trefs/tags/v2.3.12",
    "c\trefs/tags/v5.2",
    "d\trefs/tags/v1.10.0",
    "e\trefs/tags/v1.9.99",
  ].join("\n");
  assert.equal(latestReleaseTag(refs), "v5.2");
});

test("ignores branches, prereleases, and malformed tags", () => {
  const refs = [
    "a\trefs/heads/v9.0",
    "b\trefs/tags/latest",
    "c\trefs/tags/v3.1-beta",
    "d\trefs/tags/v3.0.4",
    "e\trefs/tags/v3.0.4^{}",
  ].join("\n");
  assert.equal(latestReleaseTag(refs), "v3.0.4");
  assert.equal(latestReleaseTag("a\trefs/tags/not-a-version"), undefined);
});

test("compares installed and available release tags", () => {
  assert.equal(isNewerReleaseTag("v2.0", "v1.9.9"), true);
  assert.equal(isNewerReleaseTag("v1.9.9", "v2.0"), false);
  assert.equal(isNewerReleaseTag("v2.0", "v2.0"), false);
  assert.equal(isNewerReleaseTag("latest", "v2.0"), false);
});
