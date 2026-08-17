import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
    const managed = await findManagedServer(resolve(wlPath));
    if (managed) {
      candidates.push(managed);
    }
  }

  const compiler = await findCompiler();
  if (compiler) {
    const compilerRoot = await findWhiteLanguageRoot(compiler);
    if (compilerRoot) {
      candidates.push(join(compilerRoot, "bin", executableName));
      const managed = await findManagedServer(compilerRoot);
      if (managed) {
        candidates.push(managed);
      }
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

export function managedServerPath(wlPath: string, version?: string): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executableName = version ? `wlls-${version}${suffix}` : `wlls${suffix}`;
  return join(wlPath, "tools", "wlls", "bin", executableName);
}

export async function findManagedServer(
  wlPath: string,
): Promise<string | undefined> {
  const metadataPath = join(wlPath, "tools", "wlls", "version.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      executable?: unknown;
    };
    if (
      typeof metadata.executable === "string" &&
      basename(metadata.executable) === metadata.executable
    ) {
      const candidate = join(
        wlPath,
        "tools",
        "wlls",
        "bin",
        metadata.executable,
      );
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  } catch {
    // installations made before versioned binaries have no executable field
  }

  const legacy = managedServerPath(wlPath);
  return (await isExecutableFile(legacy)) ? legacy : undefined;
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
