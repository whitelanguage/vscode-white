import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import * as vscode from "vscode";
import { findCompiler } from "./compiler";

const activeCompilations = new Set<string>();

export function registerRunner(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const initialCleanup = cleanupRunDirectory(context, output);
  return vscode.commands.registerCommand("whitelanguage.runFile", async () => {
    try {
      await initialCleanup;
      await runActiveFile(context, output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`run failed: ${message}`);
      void vscode.window.showErrorMessage(
        `White Language run failed: ${message}`,
      );
    }
  });
}

async function runActiveFile(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor ||
    editor.document.languageId !== "whitelang" ||
    editor.document.uri.scheme !== "file"
  ) {
    void vscode.window.showWarningMessage(
      "Open a White Language file to run it.",
    );
    return;
  }

  if (editor.document.isDirty && !(await editor.document.save())) {
    return;
  }

  const compiler = await findCompiler();
  if (!compiler) {
    const action = await vscode.window.showErrorMessage(
      "White Language compiler was not found.",
      "Open Settings",
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "whitelanguage.compiler.path",
      );
    }
    return;
  }

  const source = editor.document.uri.fsPath;
  const sourceKey =
    process.platform === "win32" ? source.toLowerCase() : source;
  if (activeCompilations.has(sourceKey)) {
    void vscode.window.showInformationMessage(
      `${basename(source)} is already being compiled.`,
    );
    return;
  }

  activeCompilations.add(sourceKey);
  let executable: string | undefined;
  try {
    const runDirectory = join(context.globalStorageUri.fsPath, "run");
    await mkdir(runDirectory, { recursive: true });
    const sourceName = basename(source, extname(source));
    const sourceId = createHash("sha256")
      .update(source)
      .digest("hex")
      .slice(0, 12);
    const executableName =
      process.platform === "win32"
        ? `${sourceName}-${sourceId}.exe`
        : `${sourceName}-${sourceId}`;
    executable = join(runDirectory, executableName);
    await removeRunArtifact(executable);
    const scope =
      vscode.workspace.getWorkspaceFolder(editor.document.uri) ??
      vscode.TaskScope.Global;
    const compileTask = createTask(
      scope,
      "compile",
      source,
      `Compile ${basename(source)}`,
      new vscode.ProcessExecution(compiler, [source, "-o", executable], {
        cwd: dirname(source),
      }),
      true,
    );

    output.appendLine(`compiling ${source}`);
    const exitCode = await executeAndWait(compileTask);
    if (exitCode !== 0) {
      output.appendLine(
        `compilation failed (${exitCode ?? "unknown exit code"})`,
      );
      return;
    }

    const runTask = createTask(
      scope,
      "run",
      source,
      `Run ${basename(source)}`,
      new vscode.ProcessExecution(executable, [], { cwd: dirname(source) }),
      false,
    );
    await executeAndWait(runTask);
  } finally {
    activeCompilations.delete(sourceKey);
    if (executable) {
      await removeRunArtifact(executable).catch((error: unknown) => {
        output.appendLine(
          `failed to remove run artifact ${executable}: ${formatError(error)}`,
        );
      });
    }
  }
}

async function cleanupRunDirectory(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const runDirectory = join(context.globalStorageUri.fsPath, "run");
  await rm(runDirectory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  }).catch((error: unknown) => {
    output.appendLine(
      `failed to clean run directory ${runDirectory}: ${formatError(error)}`,
    );
  });
}

async function removeRunArtifact(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTask(
  scope: vscode.WorkspaceFolder | vscode.TaskScope,
  action: string,
  source: string,
  name: string,
  execution: vscode.ProcessExecution,
  clear: boolean,
): vscode.Task {
  const task = new vscode.Task(
    {
      type: "whitelanguage",
      action,
      source,
      runId: randomUUID(),
    },
    scope,
    name,
    "White Language",
    execution,
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    clear,
    focus: !clear,
    showReuseMessage: false,
  };
  return task;
}

function executeAndWait(task: vscode.Task): Promise<number | undefined> {
  const runId = task.definition.runId;
  return new Promise((resolveExit, reject) => {
    let settled = false;
    const finish = (exitCode: number | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      processSubscription.dispose();
      taskSubscription.dispose();
      resolveExit(exitCode);
    };
    const processSubscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.runId === runId) {
        finish(event.exitCode);
      }
    });
    const taskSubscription = vscode.tasks.onDidEndTask((event) => {
      if (event.execution.task.definition.runId === runId) {
        finish(undefined);
      }
    });

    void Promise.resolve(vscode.tasks.executeTask(task)).catch(
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        processSubscription.dispose();
        taskSubscription.dispose();
        reject(error);
      },
    );
  });
}
