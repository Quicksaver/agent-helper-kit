import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OUTPUT_DIR_NAME = 'agent-helper-kit-terminal-output';
const OUTPUT_FILE_PREFIX = 'terminal-';
const OUTPUT_FILE_SUFFIX = '.log';
const METADATA_FILE_PREFIX = 'metadata-';
const METADATA_FILE_SUFFIX = '.json';
const DEFAULT_STARTUP_PURGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface TerminalCommandMetadata {
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

export function getTerminalOutputDirectoryPath(): string {
  return getOutputDirectoryPath();
}

function ensureOutputDirectory(): string {
  const directoryPath = getOutputDirectoryPath();

  fs.mkdirSync(directoryPath, { recursive: true });

  return directoryPath;
}

function sanitizeTerminalId(terminalId: string): string {
  return terminalId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}

export function getTerminalOutputFilePath(terminalId: string): string {
  const safeId = sanitizeTerminalId(terminalId);
  return path.join(ensureOutputDirectory(), `${OUTPUT_FILE_PREFIX}${safeId}${OUTPUT_FILE_SUFFIX}`);
}

function getTerminalIdFromFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(OUTPUT_FILE_PREFIX) || !fileName.endsWith(OUTPUT_FILE_SUFFIX)) {
    return undefined;
  }

  return fileName.slice(OUTPUT_FILE_PREFIX.length, -OUTPUT_FILE_SUFFIX.length);
}

function getTerminalIdFromMetadataFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(METADATA_FILE_PREFIX) || !fileName.endsWith(METADATA_FILE_SUFFIX)) {
    return undefined;
  }

  return fileName.slice(METADATA_FILE_PREFIX.length, -METADATA_FILE_SUFFIX.length);
}

function getTerminalMetadataFilePath(terminalId: string): string {
  const safeId = sanitizeTerminalId(terminalId);
  return path.join(ensureOutputDirectory(), `${METADATA_FILE_PREFIX}${safeId}${METADATA_FILE_SUFFIX}`);
}

export function initializeTerminalOutputStore(startupPurgeMaxAgeMs = DEFAULT_STARTUP_PURGE_MAX_AGE_MS): void {
  const directoryPath = ensureOutputDirectory();
  const nowMs = Date.now();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to read terminal output directory ${directoryPath}: ${message}\n`);
    return;
  }

  for (const fileName of fileNames) {
    const terminalId = getTerminalIdFromFileName(fileName);

    if (!terminalId) {
      continue;
    }

    const filePath = path.join(directoryPath, fileName);
    let fileStats: fs.Stats;

    try {
      fileStats = fs.statSync(filePath);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      globalThis.process.stderr.write(`[agent-helper-kit] Failed to stat terminal output file ${filePath}: ${message}\n`);
      continue;
    }

    const ageMs = nowMs - fileStats.mtimeMs;

    if (ageMs > startupPurgeMaxAgeMs) {
      try {
        fs.rmSync(filePath, { force: true });
        fs.rmSync(getTerminalMetadataFilePath(terminalId), { force: true });
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        globalThis.process.stderr.write(`[agent-helper-kit] Failed to purge stale terminal output artifacts for ${terminalId}: ${message}\n`);
      }
    }
  }
}

export function listTerminalOutputIds(): string[] {
  const directoryPath = ensureOutputDirectory();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch {
    return [];
  }

  return fileNames
    .map(getTerminalIdFromFileName)
    .filter((terminalId): terminalId is string => typeof terminalId === 'string')
    .sort();
}

export function createTerminalOutputFile(terminalId: string): void {
  fs.writeFileSync(getTerminalOutputFilePath(terminalId), '', { encoding: 'utf8' });
}

export function overwriteTerminalOutput(terminalId: string, output: string): void {
  try {
    fs.writeFileSync(getTerminalOutputFilePath(terminalId), output, { encoding: 'utf8' });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to overwrite terminal output for ${terminalId}: ${message}\n`);
  }
}

export function appendTerminalOutput(terminalId: string, chunk: string): void {
  try {
    fs.appendFileSync(getTerminalOutputFilePath(terminalId), chunk, { encoding: 'utf8' });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to append terminal output for ${terminalId}: ${message}\n`);
  }
}

export async function readTerminalOutput(terminalId: string): Promise<string> {
  const filePath = getTerminalOutputFilePath(terminalId);

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

export function removeTerminalOutputFile(terminalId: string): void {
  fs.rmSync(getTerminalOutputFilePath(terminalId), { force: true });
}

export function readTerminalCommandMetadata(terminalId: string): TerminalCommandMetadata | undefined {
  try {
    const raw = fs.readFileSync(getTerminalMetadataFilePath(terminalId), { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const candidate = parsed as Partial<TerminalCommandMetadata>;

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

export function removeTerminalCommandMetadata(terminalId: string): void {
  fs.rmSync(getTerminalMetadataFilePath(terminalId), { force: true });
}

export function writeTerminalCommandMetadata(metadata: TerminalCommandMetadata): void {
  try {
    fs.writeFileSync(
      getTerminalMetadataFilePath(metadata.id),
      JSON.stringify(metadata),
      { encoding: 'utf8' },
    );
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[agent-helper-kit] Failed to write terminal metadata for ${metadata.id}: ${message}\n`);
  }
}

export function listTerminalMetadataIds(): string[] {
  const directoryPath = ensureOutputDirectory();
  let fileNames: string[];

  try {
    fileNames = fs.readdirSync(directoryPath);
  }
  catch {
    return [];
  }

  return fileNames
    .map(getTerminalIdFromMetadataFileName)
    .filter((terminalId): terminalId is string => typeof terminalId === 'string')
    .sort();
}
