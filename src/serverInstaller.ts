import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { findCompiler } from "./compiler";
import { isExecutableFile } from "./executable";
import { isNewerReleaseTag, latestReleaseTag } from "./releaseTags";
import {
  findManagedServer,
  findWhiteLanguageRoot,
  managedServerPath,
} from "./server";

const repository = "https://github.com/whitelanguage/wlls.git";
const gitDownloadUrl = "https://git-scm.com/downloads";
const whiteLanguageDownloadUrl = "https://www.white-lang.org";
const maxCapturedOutput = 4 * 1024 * 1024;
const updateCheckTimeout = 15_000;

let currentInstallation: Promise<string | undefined> | undefined;

export function installLatestServer(
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  if (currentInstallation) {
    return currentInstallation;
  }
  currentInstallation = installLatestServerOnce(output).finally(() => {
    currentInstallation = undefined;
  });
  return currentInstallation;
}

export async function updateManagedServer(
  executable: string,
  wlPath: string,
  output: vscode.OutputChannel,
): Promise<string> {
  const updatesEnabled = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<boolean>("server.checkForUpdates", true);
  const managed = await findManagedServer(wlPath);
  if (!updatesEnabled || !managed || !samePath(executable, managed)) {
    return executable;
  }

  const metadataPath = join(wlPath, "tools", "wlls", "version.json");
  let installedVersion: string;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof metadata.version !== "string") {
      return executable;
    }
    installedVersion = metadata.version;
  } catch {
    return executable;
  }

  let latestVersion: string | undefined;
  while (!latestVersion) {
    const args = ["ls-remote", "--tags", "--refs", repository, "refs/tags/v*"];
    const result = await runCommand(
      "git",
      args,
      undefined,
      undefined,
      gitEnvironment(),
      updateCheckTimeout,
    );
    if (!result.startError && result.exitCode === 0) {
      latestVersion = latestReleaseTag(result.stdout);
    }
    if (latestVersion) {
      break;
    }

    output.appendLine(
      `wlls update check failed: ${formatFailure("git", args, result)}`,
    );
    const action = await vscode.window.showWarningMessage(
      "White Language could not check for wlls updates. Check your network connection and Git installation.",
      "Retry",
      "Cancel",
    );
    if (action !== "Retry") {
      return executable;
    }
  }

  if (!isNewerReleaseTag(latestVersion, installedVersion)) {
    return executable;
  }

  const action = await vscode.window.showInformationMessage(
    `White Language language server ${latestVersion} is available (installed: ${installedVersion}).`,
    "Update wlls",
    "Not Now",
  );
  if (action !== "Update wlls") {
    return executable;
  }

  return (await installLatestServer(output)) ?? executable;
}

async function installLatestServerOnce(
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  const compiler = await findCompiler();
  if (!compiler) {
    await offerDownload(
      "The White Language compiler is required to install wlls.",
      "Download White Language",
      whiteLanguageDownloadUrl,
    );
    return undefined;
  }

  const wlPath = await findWhiteLanguageRoot(compiler);
  if (!wlPath) {
    await offerDownload(
      "The White Language installation root could not be found. Set WL_PATH to a directory containing std.",
      "Download White Language",
      whiteLanguageDownloadUrl,
    );
    return undefined;
  }

  const gitCheck = await runCommand("git", ["--version"]);
  if (gitCheck.startError) {
    await offerDownload(
      "Git is required to install wlls.",
      "Download Git",
      gitDownloadUrl,
    );
    return undefined;
  }
  if (gitCheck.exitCode !== 0) {
    output.appendLine(formatFailure("git", ["--version"], gitCheck));
    await offerDownload(
      "Git is installed but could not be started.",
      "Download Git",
      gitDownloadUrl,
    );
    return undefined;
  }

  let failureMessage: string | undefined;
  const installed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Installing White Language language server",
      cancellable: true,
    },
    async (progress, token) => {
      let stagingDirectory: string | undefined;
      let stagedInstall: string | undefined;
      let metadataTemporary: string | undefined;
      try {
        progress.report({ message: "Finding the latest release…" });
        const refs = await runChecked(
          "git",
          ["ls-remote", "--tags", "--refs", repository, "refs/tags/v*"],
          output,
          token,
          undefined,
          gitEnvironment(),
        );
        const tag = latestReleaseTag(refs.stdout);
        if (!tag) {
          throw new Error("The wlls repository has no valid v* release tag.");
        }

        stagingDirectory = await createStagingDirectory();
        output.appendLine(`wlls build directory: ${stagingDirectory}`);
        const sourceDirectory = join(stagingDirectory, "source");
        progress.report({ message: `Downloading wlls ${tag}…` });
        await runChecked(
          "git",
          [
            "clone",
            "--depth",
            "1",
            "--branch",
            tag,
            "--single-branch",
            repository,
            sourceDirectory,
          ],
          output,
          token,
          undefined,
          gitEnvironment(),
        );

        const executableName =
          process.platform === "win32" ? "wlls.exe" : "wlls";
        const builtExecutable = join(stagingDirectory, executableName);
        const compilerOutput = join("..", executableName);
        progress.report({ message: `Building wlls ${tag}…` });
        await runChecked(
          compiler,
          ["wlls.wl", "-o", compilerOutput],
          output,
          token,
          sourceDirectory,
          { ...process.env, WL_PATH: wlPath },
        );

        const target = managedServerPath(wlPath, tag);
        const targetDirectory = join(wlPath, "tools", "wlls", "bin");
        await mkdir(targetDirectory, { recursive: true });
        stagedInstall = join(
          targetDirectory,
          `.${executableName}.${randomUUID()}.tmp`,
        );
        await copyFile(builtExecutable, stagedInstall);
        if (process.platform !== "win32") {
          await chmod(stagedInstall, 0o755);
        }
        try {
          await rename(stagedInstall, target);
        } catch (error) {
          if (!(await isExecutableFile(target))) {
            throw error;
          }
          await rm(stagedInstall, { force: true });
        }
        stagedInstall = undefined;

        const metadataPath = join(wlPath, "tools", "wlls", "version.json");
        metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`;
        await writeFile(
          metadataTemporary,
          `${JSON.stringify(
            {
              version: tag,
              executable: basename(target),
              repository,
              installedAt: new Date().toISOString(),
            },
            undefined,
            2,
          )}\n`,
          "utf8",
        );
        await rm(metadataPath, { force: true });
        await rename(metadataTemporary, metadataPath);
        metadataTemporary = undefined;

        output.appendLine(`installed wlls ${tag}: ${target}`);
        void vscode.window.showInformationMessage(
          `White Language language server ${tag} was installed.`,
        );
        return target;
      } catch (error) {
        if (error instanceof InstallationCancelled) {
          output.appendLine("wlls installation cancelled");
          return undefined;
        }
        failureMessage = error instanceof Error ? error.message : String(error);
        output.appendLine(`wlls installation failed: ${failureMessage}`);
        return undefined;
      } finally {
        if (stagedInstall) {
          await rm(stagedInstall, { force: true }).catch(() => undefined);
        }
        if (metadataTemporary) {
          await rm(metadataTemporary, { force: true }).catch(() => undefined);
        }
        if (stagingDirectory) {
          await rm(stagingDirectory, {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
      }
    },
  );

  if (installed) {
    return installed;
  }
  if (!failureMessage) {
    return undefined;
  }

  const action = await vscode.window.showErrorMessage(
    `Failed to install White Language language server: ${failureMessage}`,
    "Retry",
    "Show Log",
  );
  if (action === "Retry") {
    return installLatestServerOnce(output);
  }
  if (action === "Show Log") {
    output.show(true);
  }
  return undefined;
}

export async function cleanupManagedServers(
  wlPath: string,
  currentExecutable: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const managed = await findManagedServer(wlPath);
  if (!managed || !samePath(currentExecutable, managed)) {
    return;
  }

  const directory = join(wlPath, "tools", "wlls", "bin");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const current = normalizedPath(currentExecutable);
  const versionedPattern =
    process.platform === "win32"
      ? /^wlls-v\d+(?:\.\d+){0,2}\.exe$/
      : /^wlls-v\d+(?:\.\d+){0,2}$/;
  const legacyName = process.platform === "win32" ? "wlls.exe" : "wlls";

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (entry.name !== legacyName && !versionedPattern.test(entry.name))
    ) {
      continue;
    }
    const candidate = join(directory, entry.name);
    if (normalizedPath(candidate) === current) {
      continue;
    }
    await rm(candidate, { force: true }).catch((error: unknown) => {
      output.appendLine(
        `could not remove old wlls ${candidate}: ${formatUnknownError(error)}`,
      );
    });
  }
}

async function createStagingDirectory(): Promise<string> {
  const candidates =
    process.platform === "win32"
      ? [
          tmpdir(),
          process.env.ProgramData
            ? join(process.env.ProgramData, "WhiteLanguage", "Temp")
            : undefined,
          process.env.PUBLIC
            ? join(process.env.PUBLIC, "Documents", "WhiteLanguage", "Temp")
            : undefined,
          process.env.SystemRoot
            ? join(process.env.SystemRoot, "Temp", "WhiteLanguage")
            : undefined,
        ]
      : [tmpdir()];

  let lastError: unknown;
  for (const candidate of new Set(candidates)) {
    if (!candidate) {
      continue;
    }
    if (process.platform === "win32" && !/^[\u0000-\u007f]+$/.test(candidate)) {
      continue;
    }
    try {
      await mkdir(candidate, { recursive: true });
      return await mkdtemp(join(candidate, "whitelanguage-wlls-"));
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Could not create an ASCII-only temporary directory for wlc${detail}`,
  );
}

async function offerDownload(
  message: string,
  action: string,
  url: string,
): Promise<void> {
  const selected = await vscode.window.showErrorMessage(message, action);
  if (selected === action) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startError?: Error;
}

async function runChecked(
  command: string,
  args: string[],
  output: vscode.OutputChannel,
  token: vscode.CancellationToken,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCommand(command, args, token, cwd, env);
  if (result.startError || result.exitCode !== 0) {
    const failure = formatFailure(command, args, result);
    output.appendLine(failure);
    const reason = result.startError
      ? result.startError.message
      : `exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(`${command} failed (${reason})`);
  }
  return result;
}

function runCommand(
  command: string,
  args: string[],
  token?: vscode.CancellationToken,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cancellation = token?.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });
    const timeout = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : undefined;

    const finish = (): void => {
      cancellation?.dispose();
      if (timeout) {
        clearTimeout(timeout);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      resolveCommand({
        exitCode: null,
        stdout,
        stderr,
        startError: error,
      });
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      if (cancelled) {
        resolveCommand({
          exitCode,
          stdout,
          stderr,
          startError: new InstallationCancelled(),
        });
        return;
      }
      if (timedOut) {
        resolveCommand({
          exitCode,
          stdout,
          stderr,
          startError: new Error(`Command timed out after ${timeoutMs} ms.`),
        });
        return;
      }
      resolveCommand({ exitCode, stdout, stderr });
    });
  }).then((result) => {
    if (result.startError instanceof InstallationCancelled) {
      throw result.startError;
    }
    return result;
  });
}

function appendOutput(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length <= maxCapturedOutput
    ? combined
    : combined.slice(combined.length - maxCapturedOutput);
}

function formatFailure(
  command: string,
  args: string[],
  result: CommandResult,
): string {
  const detail = (result.stderr || result.stdout).trim();
  const conciseDetail =
    detail.length <= 4000 ? detail : `…${detail.slice(detail.length - 4000)}`;
  const reason = result.startError
    ? result.startError.message
    : `exit code ${result.exitCode ?? "unknown"}`;
  return `${command} ${args.join(" ")} failed (${reason})${
    conciseDetail ? `: ${conciseDetail}` : ""
  }`;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InstallationCancelled extends Error {
  constructor() {
    super("Installation cancelled.");
    this.name = "InstallationCancelled";
  }
}
