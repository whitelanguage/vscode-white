import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { findCompiler } from "./compiler";
import { latestReleaseTag } from "./releaseTags";
import { findWhiteLanguageRoot, managedServerPath } from "./server";

const repository =
  "https://github.com/whitelanguage/wlls.git";
const gitDownloadUrl = "https://git-scm.com/downloads";
const whiteLanguageDownloadUrl = "https://www.white-lang.org";
const maxCapturedOutput = 4 * 1024 * 1024;

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

        const target = managedServerPath(wlPath);
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
        await rm(target, { force: true });
        await rename(stagedInstall, target);
        stagedInstall = undefined;

        const metadataPath = join(wlPath, "tools", "wlls", "version.json");
        metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`;
        await writeFile(
          metadataTemporary,
          `${JSON.stringify(
            {
              version: tag,
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
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let cancelled = false;
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
      cancellation?.dispose();
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
      cancellation?.dispose();
      if (cancelled) {
        resolveCommand({
          exitCode,
          stdout,
          stderr,
          startError: new InstallationCancelled(),
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

class InstallationCancelled extends Error {
  constructor() {
    super("Installation cancelled.");
    this.name = "InstallationCancelled";
  }
}
