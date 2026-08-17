interface ReleaseTag {
  name: string;
  version: [number, number, number];
  componentCount: number;
}

export function latestReleaseTag(refs: string): string | undefined {
  let latest: ReleaseTag | undefined;

  for (const line of refs.split(/\r?\n/)) {
    const marker = "refs/tags/";
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }

    const name = line.slice(markerIndex + marker.length).trim();
    const candidate = parseReleaseTag(name);
    if (!candidate) {
      continue;
    }
    if (!latest || compareReleaseTags(candidate, latest) > 0) {
      latest = candidate;
    }
  }
  return latest?.name;
}

export function isNewerReleaseTag(
  candidateName: string,
  currentName: string,
): boolean {
  const candidate = parseReleaseTag(candidateName);
  const current = parseReleaseTag(currentName);
  return !!candidate && !!current && compareReleaseTags(candidate, current) > 0;
}

function parseReleaseTag(name: string): ReleaseTag | undefined {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(name);
  if (!match) {
    return undefined;
  }

  const parts = match.slice(1).filter((part) => part !== undefined);
  const values = parts.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    return undefined;
  }
  return {
    name,
    version: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
    componentCount: parts.length,
  };
}

function compareReleaseTags(left: ReleaseTag, right: ReleaseTag): number {
  for (let i = 0; i < left.version.length; i += 1) {
    if (left.version[i] !== right.version[i]) {
      return left.version[i] - right.version[i];
    }
  }
  if (left.componentCount !== right.componentCount) {
    return left.componentCount - right.componentCount;
  }
  return left.name.localeCompare(right.name);
}
