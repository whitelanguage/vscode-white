const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const extension = readFileSync(resolve(root, "src", "extension.ts"), "utf8");
const server = readFileSync(resolve(root, "src", "server.ts"), "utf8");
const installer = readFileSync(
  resolve(root, "src", "serverInstaller.ts"),
  "utf8",
);
const compiler = readFileSync(resolve(root, "src", "compiler.ts"), "utf8");
const runner = readFileSync(resolve(root, "src", "runner.ts"), "utf8");
const diagnosticPolicy = readFileSync(
  resolve(root, "src", "diagnosticPolicy.ts"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const vscodeIgnore = readFileSync(resolve(root, ".vscodeignore"), "utf8");

test("uses one standard LSP document lifecycle", () => {
  assert.match(extension, /new LanguageClient/);
  assert.doesNotMatch(extension, /openTextDocument|findFiles/);
  assert.doesNotMatch(extension, /sendNotification/);
  assert.doesNotMatch(
    extension,
    /textDocument\/(?:didOpen|didChange|didClose)/,
  );
});

test("passes semantic and outline requests directly to the LSP client", () => {
  assert.doesNotMatch(extension, /provideDocumentSemanticTokens/);
  assert.doesNotMatch(extension, /provideDocumentSymbols/);
  assert.doesNotMatch(extension, /waitForVisibleDocument/);
  assert.doesNotMatch(extension, /SemanticTokensRegistrationType/);
  assert.doesNotMatch(extension, /onDidChangeSemanticTokensEmitter/);
  assert.doesNotMatch(extension, /refreshSemanticTokens/);
});

test("passes a validated White Language root to wlls", () => {
  assert.match(extension, /findWhiteLanguageRoot\(executable\)/);
  assert.match(extension, /options:\s*\{[\s\S]*env:\s*\{/);
  assert.match(extension, /WL_PATH:\s*wlPath/);
  assert.match(server, /managedServerPath/);
  assert.match(server, /findManagedServer/);
  assert.match(server, /metadata\.executable/);
  assert.match(server, /depth < 6/);
  assert.match(server, /stat\(join\(path,\s*"std"\)\)/);
  assert.doesNotMatch(server, /stat\(join\(path,\s*"runtime"\)\)/);
});

test("installs the latest tagged wlls release without a shell", () => {
  assert.match(extension, /installLatestServer/);
  assert.match(extension, /"Install wlls"/);
  assert.match(installer, /https:\/\/github\.com\/whitelanguage\/wlls\.git/);
  assert.match(installer, /"ls-remote"/);
  assert.match(installer, /"refs\/tags\/v\*"/);
  assert.match(installer, /"--depth",\s*"1"/);
  assert.match(installer, /"--branch",\s*tag/);
  assert.match(
    installer,
    /const compilerOutput = join\("\.\.", executableName\)/,
  );
  assert.match(installer, /\["wlls\.wl",\s*"-o",\s*compilerOutput\]/);
  assert.match(installer, /shell:\s*false/);
  assert.match(installer, /createStagingDirectory/);
  assert.match(installer, /"Retry"/);
  assert.match(installer, /recursive:\s*true,\s*force:\s*true/);
  assert.match(installer, /tools",\s*"wlls",\s*"bin"/);
  assert.match(installer, /managedServerPath\(wlPath, tag\)/);
  assert.match(installer, /executable:\s*basename\(target\)/);
  assert.match(
    compiler,
    /getConfiguration\("whitelanguage"\)[\s\S]*"compiler\.path"/,
  );
});

test("checks managed wlls installations for updates", () => {
  assert.match(extension, /updateManagedServer\(executable, wlPath, output\)/);
  assert.match(installer, /version\.json/);
  assert.match(installer, /server\.checkForUpdates/);
  assert.doesNotMatch(installer, /lastUpdateCheckKey|updateCheckInterval/);
  assert.match(installer, /isNewerReleaseTag/);
  assert.match(installer, /"Update wlls"/);
  assert.match(installer, /"Retry"/);
  assert.match(installer, /"Cancel"/);
  assert.match(installer, /const updateCheckTimeout = 15_000/);
});

test("keeps running wlls versions until they can be cleaned safely", () => {
  assert.match(
    extension,
    /cleanupManagedServers\(wlPath, executable, output\)/,
  );
  assert.match(installer, /cleanupManagedServers/);
  assert.match(installer, /!samePath\(currentExecutable, managed\)/);
  assert.match(installer, /versionedPattern/);
  assert.doesNotMatch(installer, /await rm\(target, \{ force: true \}\);/);
});

test("preserves cached diagnostics only in non-open-file modes", () => {
  assert.match(extension, /beforeDocumentClose/);
  assert.match(diagnosticPolicy, /this\.mode !== "openFiles"/);
  assert.match(diagnosticPolicy, /reset\(\)/);
});

test("bundles the language client without shipping build artifacts", () => {
  assert.match(manifest.scripts.compile, /scripts\/build\.mjs/);
  assert.match(vscodeIgnore, /node_modules\/\*\*/);
  assert.match(vscodeIgnore, /out\/\*\*\/\*\.map/);
});

test("removes temporary run executables", () => {
  assert.match(runner, /cleanupRunDirectory\(context, output\)/);
  assert.match(runner, /rm\(runDirectory,[\s\S]*recursive:\s*true/);
  assert.match(runner, /finally\s*\{[\s\S]*removeRunArtifact\(executable\)/);
});

test("reuses one terminal for compile and run tasks", () => {
  assert.match(runner, /panel:\s*vscode\.TaskPanelKind\.Shared/);
  assert.match(runner, /showReuseMessage:\s*false/);
});
