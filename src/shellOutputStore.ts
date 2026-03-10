import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OUTPUT_DIR_NAME = 'agent-helper-kit-shell-output';
const OUTPUT_FILE_PREFIX = 'output-';
const OUTPUT_FILE_SUFFIX = '.log';
const METADATA_FILE_PREFIX = 'metadata-';
const METADATA_FILE_SUFFIX = '.json';
const DEFAULT_STARTUP_PURGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ShellCommandMetadata {
  command: string;
  completedAt: null | string;
  exitCode: null | number;
  id: string;
  killedByUser: boolean;
  shell: string;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

function getOutputDirectoryPath(): string {
  return path.join(os.tmpdir(), OUTPUT_DIR_NAME);
}

export function getShellOutputDirectoryPath(): string {
  return getOutputDirectoryPath();
}

function ensureOutputDirectory(): string {
  const directoryPath = getOutputDirectoryPath();

  fs.mkdirSync(directoryPath, { recursive: true });

  return directoryPath;
}

function sanitizeShellId(shellId: string): string {
  return shellId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}

export function getShellOutputFilePath(shellId: string): string {
  const safeId = sanitizeShellId(shellId);
  return path.join(ensureOutputDirectory(), `${OUTPUT_FILE_PREFIX}${safeId}${OUTPUT_FILE_SUFFIX}`);
}

function getShellIdFromOutputFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(OUTPUT_FILE_PREFIX) || !fileName.endsWith(OUTPUT_FILE_SUFFIX)) {
    return undefined;
  }

  return fileName.slice(OUTPUT_FILE_PREFIX.length, -OUTPUT_FILE_SUFFIX.length);
}

function getShellIdFromMetadataFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(METADATA_FILE_PREFIX) || !fileName.endsWith(METADATA_FILE_SUFFIX)) {
    return undefined;
  }

  return fileName.slice(METADATA_FILE_PREFIX.length, -METADATA_FILE_SUFFIX.length);
}

function getShellMetadataFilePath(shellId: string): string {
  const safeId = sanitizeShellId(shellId);
  return path.join(ensureOutputDirectory(), `${METADATA_FILE_PREFIX}${safeId}${METADATA_FILE_SUFFIX}`);
}

export function initializeShellOutputStore(startupPurgeMaxAgeMs = DEFAULT_STARTUP_PURGE_MAX_AGE_MS): void {
  const directoryPath = ensureOutputDirectory();
  const nowMs = Date.now();
  const latestArtifactMtimeByShellId = new Map<string, number>();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to read shell output directory ${directoryPath}: ${message}\n`);
    return;
  }

  for (const fileName of fileNames) {
    const shellId = getShellIdFromOutputFileName(fileName) ?? getShellIdFromMetadataFileName(fileName);

    if (!shellId) {
      continue;
    }

    const filePath = path.join(directoryPath, fileName);
    let fileStats: fs.Stats;

    try {
      fileStats = fs.statSync(filePath);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      globalThis.process.stderr.write(`[agent-helper-kit] Failed to stat shell output file ${filePath}: ${message}\n`);
      continue;
    }

    const ageMs = nowMs - fileStats.mtimeMs;

    if (ageMs <= startupPurgeMaxAgeMs) {
      const previousMtimeMs = latestArtifactMtimeByShellId.get(shellId) ?? 0;
      latestArtifactMtimeByShellId.set(shellId, Math.max(previousMtimeMs, fileStats.mtimeMs));
      continue;
    }

    if (!latestArtifactMtimeByShellId.has(shellId)) {
      latestArtifactMtimeByShellId.set(shellId, fileStats.mtimeMs);
    }
  }

  for (const [
    shellId,
    latestArtifactMtimeMs,
  ] of latestArtifactMtimeByShellId.entries()) {
    if ((nowMs - latestArtifactMtimeMs) <= startupPurgeMaxAgeMs) {
      continue;
    }

    try {
      fs.rmSync(getShellOutputFilePath(shellId), { force: true });
      fs.rmSync(getShellMetadataFilePath(shellId), { force: true });
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      globalThis.process.stderr.write(`[agent-helper-kit] Failed to purge stale shell output artifacts for ${shellId}: ${message}\n`);
    }
  }
}

export function listShellOutputIds(): string[] {
  const directoryPath = ensureOutputDirectory();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch {
    return [];
  }

  return fileNames
    .map(getShellIdFromOutputFileName)
    .filter((shellId): shellId is string => typeof shellId === 'string')
    .sort();
}

export function createShellOutputFile(shellId: string): void {
  fs.writeFileSync(getShellOutputFilePath(shellId), '', { encoding: 'utf8' });
}

export function overwriteShellOutput(shellId: string, output: string): void {
  try {
    fs.writeFileSync(getShellOutputFilePath(shellId), output, { encoding: 'utf8' });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to overwrite shell output for ${shellId}: ${message}\n`);
  }
}

export function appendShellOutput(shellId: string, chunk: string): void {
  try {
    fs.appendFileSync(getShellOutputFilePath(shellId), chunk, { encoding: 'utf8' });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to append shell output for ${shellId}: ${message}\n`);
  }
}

export async function readShellOutput(shellId: string): Promise<string> {
  const filePath = getShellOutputFilePath(shellId);

  try {
    return await fs.promises.readFile(filePath, { encoding: 'utf8' });
  }
  catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

export function removeShellOutputFile(shellId: string): void {
  fs.rmSync(getShellOutputFilePath(shellId), { force: true });
}

export function readShellCommandMetadata(shellId: string): ShellCommandMetadata | undefined {
  try {
    const raw = fs.readFileSync(getShellMetadataFilePath(shellId), { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const candidate = parsed as Partial<ShellCommandMetadata>;

    if (
      typeof candidate.id !== 'string'
      || typeof candidate.command !== 'string'
      || typeof candidate.startedAt !== 'string'
      || (candidate.completedAt !== null && typeof candidate.completedAt !== 'string')
      || (candidate.exitCode !== null && typeof candidate.exitCode !== 'number')
      || (candidate.signal !== null && typeof candidate.signal !== 'string')
      || typeof candidate.killedByUser !== 'boolean'
    ) {
      return undefined;
    }

    return {
      command: candidate.command,
      completedAt: candidate.completedAt,
      exitCode: candidate.exitCode,
      id: candidate.id,
      killedByUser: candidate.killedByUser,
      shell: typeof candidate.shell === 'string' ? candidate.shell : '',
      signal: candidate.signal,
      startedAt: candidate.startedAt,
    };
  }
  catch {
    return undefined;
  }
}

export function removeShellCommandMetadata(shellId: string): void {
  fs.rmSync(getShellMetadataFilePath(shellId), { force: true });
}

export function writeShellCommandMetadata(metadata: ShellCommandMetadata): void {
  try {
    fs.writeFileSync(
      getShellMetadataFilePath(metadata.id),
      JSON.stringify(metadata),
      { encoding: 'utf8' },
    );
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to write shell metadata for ${metadata.id}: ${message}\n`);
  }
}

export function listShellMetadataIds(): string[] {
  const directoryPath = ensureOutputDirectory();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch {
    return [];
  }

  return fileNames
    .map(getShellIdFromMetadataFileName)
    .filter((shellId): shellId is string => typeof shellId === 'string')
    .sort();
}
