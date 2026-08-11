import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  Trace,
} from "vscode-languageclient/node";
import { DiagnosticPolicy } from "./diagnosticPolicy";
import { findServer, findWhiteLanguageRoot, formatError } from "./server";
import { installLatestServer } from "./serverInstaller";
import { registerRunner } from "./runner";

let client: LanguageClient | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("White Language", {
    log: true,
  });
  context.subscriptions.push(output, registerRunner(context, output));

  let executable = await findServer();
  if (!executable) {
    const action = await vscode.window.showWarningMessage(
      "White Language language server was not found. Install the latest wlls release now?",
      "Install wlls",
      "Open Settings",
    );
    if (action === "Install wlls") {
      executable = await installLatestServer(output);
    } else if (action === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "whitelanguage.server.path",
      );
    }
    if (!executable) {
      return;
    }
  }

  const wlPath = await findWhiteLanguageRoot(executable);
  if (!wlPath) {
    void vscode.window.showErrorMessage(
      "White Language language features are unavailable because the installation root could not be found. Set WL_PATH to a directory containing std.",
    );
    return;
  }

  const diagnostics = new DiagnosticPolicy();
  const serverOptions: ServerOptions = {
    command: executable,
    args: ["--stdio"],
    options: {
      env: {
        ...process.env,
        WL_PATH: wlPath,
      },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "whitelang" }],
    outputChannel: output,
    traceOutputChannel: output,
    middleware: {
      handleDiagnostics: (uri, items, next) => {
        diagnostics.handle(uri, items, next);
      },
      didClose: async (document, next) => {
        diagnostics.beforeDocumentClose(document.uri);
        await next(document);
      },
    },
  };

  const languageClient = new LanguageClient(
    "whitelanguage",
    "White Language",
    serverOptions,
    clientOptions,
  );
  client = languageClient;
  context.subscriptions.push(
    diagnostics,
    languageClient.onDidChangeState((event) => {
      if (event.newState === State.Stopped) {
        diagnostics.reset();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("whitelanguage.server.trace")) {
        void updateTrace(languageClient).catch((error) => {
          output.appendLine(
            `failed to update protocol tracing: ${formatError(error)}`,
          );
        });
      }
      if (event.affectsConfiguration("whitelanguage.server.path")) {
        void vscode.window
          .showInformationMessage(
            "Reload VS Code to use the new White Language language server path.",
            "Reload",
          )
          .then((action) => {
            if (action === "Reload") {
              void vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
            }
          });
      }
    }),
  );

  try {
    await languageClient.start();
    await updateTrace(languageClient);
  } catch (error) {
    output.appendLine(`failed to start ${executable}: ${formatError(error)}`);
    void vscode.window.showErrorMessage(
      `White Language language server failed to start: ${formatError(error)}`,
    );
    await languageClient.stop().catch(() => undefined);
    if (client === languageClient) {
      client = undefined;
    }
    return;
  }

  output.appendLine(`White Language language server ready (${executable})`);
  output.appendLine(`WL_PATH: ${wlPath}`);
}

export async function deactivate(): Promise<void> {
  const running = client;
  client = undefined;
  await running?.stop();
}

async function updateTrace(languageClient: LanguageClient): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<boolean>("server.trace", false);
  await languageClient.setTrace(enabled ? Trace.Verbose : Trace.Off);
}
