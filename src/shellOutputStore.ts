import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { logError } from './logging.js';
import { SHELL_OUTPUT_DIR_ENV_VAR } from './shellOutputConstants.js';

export { SHELL_OUTPUT_DIR_ENV_VAR } from './shellOutputConstants.js';

const OUTPUT_DIR_NAME = 'agent-helper-kit-shell-output';
const OUTPUT_FILE_PREFIX = 'output-';
const OUTPUT_FILE_SUFFIX = '.log';
const METADATA_FILE_PREFIX = 'metadata-';
const METADATA_FILE_SUFFIX = '.json';
const DEFAULT_STARTUP_PURGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

type NodeErrorWithCode = NodeJS.ErrnoException;

function isNodeErrorWithCode(error: unknown, code?: string): error is NodeErrorWithCode & { code: string } {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || typeof error.code !== 'string'
  ) {
    return false;
  }

  return code === undefined || error.code === code;
}

export interface ShellCommandMetadata {
  command: string;
  completedAt: null | string;
  cwd: string;
  exitCode: null | number;
  id: string;
  killedByUser: boolean;
  shell: string;
  signal: NodeJS.Signals | null;
  startedAt: string;
}

function getOutputDirectoryPath(): string {
  const configuredDirectoryPath = globalThis.process.env[SHELL_OUTPUT_DIR_ENV_VAR]?.trim();

  if (configuredDirectoryPath) {
    return path.resolve(configuredDirectoryPath);
  }

  return path.join(os.tmpdir(), OUTPUT_DIR_NAME);
}

export function getShellOutputDirectoryPath(): string {
  return getOutputDirectoryPath();
}

function formatPathState(targetPath: string): string {
  try {
    const stats = fs.lstatSync(targetPath);
    let kind = 'other';

    if (stats.isDirectory()) {
      kind = 'directory';
    }
    else if (stats.isFile()) {
      kind = 'file';
    }
    else if (stats.isSymbolicLink()) {
      kind = 'symlink';
    }

    return `${kind}, mode=${stats.mode.toString(8)}, size=${String(stats.size)}`;
  }
  catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return 'missing';
    }

    return `unavailable (${isNodeErrorWithCode(error) ? error.code : 'unknown'})`;
  }
}

function formatFileSystemError(error: unknown, targetPath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const parentPath = path.dirname(targetPath);
  const errorCode = isNodeErrorWithCode(error) ? ` code=${error.code}` : '';

  return `${message}; target=${targetPath}; targetState=${formatPathState(targetPath)}; parent=${parentPath}; parentState=${formatPathState(parentPath)}${errorCode}`;
}

function canRecoverOutputDirectory(error: unknown): boolean {
  return isNodeErrorWithCode(error, 'EEXIST') || isNodeErrorWithCode(error, 'ENOTDIR');
}

function isExpectedOutputDirectoryPath(directoryPath: string): boolean {
  return path.resolve(directoryPath) === path.resolve(getOutputDirectoryPath());
}

/**
 * Ensure the file-backed shell output root exists. If the expected temp path is
 * blocked by a file or broken entry, recover by deleting that blocker before
 * treating storage initialization as failed.
 */
function ensureOutputDirectory(): string {
  const directoryPath = getOutputDirectoryPath();

  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    return directoryPath;
  }
  catch (error) {
    if (canRecoverOutputDirectory(error)) {
      try {
        const stats = fs.lstatSync(directoryPath);

        if (stats.isDirectory()) {
          return directoryPath;
        }

        if (isExpectedOutputDirectoryPath(directoryPath)) {
          fs.rmSync(directoryPath, { force: true, recursive: true });
          fs.mkdirSync(directoryPath, { recursive: true });
          return directoryPath;
        }
      }
      catch {
        // Fall through to structured diagnostics below.
      }
    }

    const details = formatFileSystemError(error, directoryPath);
    logError(`Failed to ensure shell output directory: ${details}`);
    throw error;
  }
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

/**
 * Prepare the shell output store for a new session and purge stale output and
 * metadata artifacts whose newest timestamp is older than the configured grace
 * window.
 */
export function initializeShellOutputStore(startupPurgeMaxAgeMs = DEFAULT_STARTUP_PURGE_MAX_AGE_MS): void {
  const directoryPath = ensureOutputDirectory();
  const nowMs = Date.now();
  const latestArtifactMtimeByShellId = new Map<string, number>();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch (error) {
    const details = formatFileSystemError(error, directoryPath);
    logError(`Failed to read shell output directory: ${details}`);
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
      const details = formatFileSystemError(error, filePath);
      logError(`Failed to stat shell output file: ${details}`);
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
      const details = formatFileSystemError(error, directoryPath);
      logError(`Failed to purge stale shell output artifacts for ${shellId}: ${details}`);
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

/**
 * Replace the persisted output for a shell command in one write. Callers use
 * the boolean result to decide whether to keep treating the command as
 * file-backed or to fall back to in-memory retention.
 */
export function overwriteShellOutput(shellId: string, output: string): boolean {
  let filePath = getOutputDirectoryPath();

  try {
    filePath = getShellOutputFilePath(shellId);
    fs.writeFileSync(filePath, output, { encoding: 'utf8' });
    return true;
  }
  catch (error) {
    const details = formatFileSystemError(error, filePath);
    logError(`Failed to overwrite shell output for ${shellId}: ${details}; bytes=${String(Buffer.byteLength(output, 'utf8'))}`);
    return false;
  }
}

/**
 * Append a single output chunk to the persisted log for a shell command.
 * Failures are reported to callers so the runtime can recover without losing
 * the already-written history.
 */
export function appendShellOutput(shellId: string, chunk: string): boolean {
  let filePath = getOutputDirectoryPath();

  try {
    filePath = getShellOutputFilePath(shellId);
    fs.appendFileSync(filePath, chunk, { encoding: 'utf8' });
    return true;
  }
  catch (error) {
    const details = formatFileSystemError(error, filePath);
    logError(`Failed to append shell output for ${shellId}: ${details}; bytes=${String(Buffer.byteLength(chunk, 'utf8'))}`);
    return false;
  }
}

/**
 * Read persisted shell output synchronously for recovery paths where the
 * runtime must rebuild in-memory state immediately after an append failure.
 */
export function readShellOutputSync(shellId: string): string | undefined {
  const filePath = getShellOutputFilePath(shellId);

  try {
    return fs.readFileSync(filePath, { encoding: 'utf8' });
  }
  catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return undefined;
    }

    const details = formatFileSystemError(error, filePath);
    logError(`Failed to read shell output for ${shellId}: ${details}`);
    return undefined;
  }
}

/**
 * Read persisted shell output asynchronously for normal runtime and panel
 * access. Missing files are treated as empty output because cleanup can race
 * with reads after command completion.
 */
export async function readShellOutput(shellId: string): Promise<string> {
  const filePath = getShellOutputFilePath(shellId);

  try {
    return await fs.promises.readFile(filePath, { encoding: 'utf8' });
  }
  catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return '';
    }

    throw error;
  }
}

export function removeShellOutputFile(shellId: string): void {
  fs.rmSync(getShellOutputFilePath(shellId), { force: true });
}

/**
 * Read stored command metadata defensively. Invalid or partially-written JSON
 * is ignored so corrupt artifacts do not break panel history loading.
 */
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
      || (candidate.cwd !== undefined && typeof candidate.cwd !== 'string')
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
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : os.homedir(),
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

/**
 * Persist the command metadata companion file used to reconstruct shell run
 * history across panel refreshes and spill-to-disk transitions.
 */
export function writeShellCommandMetadata(metadata: ShellCommandMetadata): void {
  let filePath = getOutputDirectoryPath();

  try {
    filePath = getShellMetadataFilePath(metadata.id);
    fs.writeFileSync(
      filePath,
      JSON.stringify(metadata),
      { encoding: 'utf8' },
    );
  }
  catch (error) {
    const details = formatFileSystemError(error, filePath);
    logError(`Failed to write shell metadata for ${metadata.id}: ${details}`);
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
