import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as vscode from "vscode";
import { findCompiler } from "./compiler";
import { isExecutableFile, resolveConfiguredPath } from "./executable";

export async function findServer(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("whitelanguage")
    .get<string>("server.path", "")
    .trim();
  const executableName = process.platform === "win32" ? "wlls.exe" : "wlls";
  const candidates: string[] = [];

  if (configured) {
    candidates.push(resolveConfiguredPath(configured));
  }

  const wlPath = process.env.WL_PATH;
  if (wlPath) {
    candidates.push(join(wlPath, "bin", executableName));
    candidates.push(managedServerPath(resolve(wlPath)));
  }

  const compiler = await findCompiler();
  if (compiler) {
    const compilerRoot = await findWhiteLanguageRoot(compiler);
    if (compilerRoot) {
      candidates.push(join(compilerRoot, "bin", executableName));
      candidates.push(managedServerPath(compilerRoot));
    }
  }

  for (const candidate of new Set(candidates)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function findWhiteLanguageRoot(
  executable: string,
): Promise<string | undefined> {
  let candidate = dirname(executable);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isWhiteLanguageRoot(candidate)) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }

  const configured = process.env.WL_PATH?.trim();
  if (configured) {
    const candidate = resolve(configured);
    if (await isWhiteLanguageRoot(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function managedServerPath(wlPath: string): string {
  const executableName = process.platform === "win32" ? "wlls.exe" : "wlls";
  return join(wlPath, "tools", "wlls", "bin", executableName);
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isWhiteLanguageRoot(path: string): Promise<boolean> {
  try {
    const standardLibrary = await stat(join(path, "std"));
    return standardLibrary.isDirectory();
  } catch {
    return false;
  }
}
