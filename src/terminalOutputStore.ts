import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OUTPUT_DIR_NAME = 'custom-vscode-terminal-output';
const OUTPUT_FILE_PREFIX = 'terminal-';
const OUTPUT_FILE_SUFFIX = '.log';

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

export function initializeTerminalOutputStore(activeTerminalIds: ReadonlySet<string>): void {
  const directoryPath = ensureOutputDirectory();

  if (activeTerminalIds.size === 0) {
    return;
  }

  const fileNames = fs.readdirSync(directoryPath);
  const sanitizedActiveIds = new Set([ ...activeTerminalIds ].map(sanitizeTerminalId));

  for (const fileName of fileNames) {
    const terminalId = getTerminalIdFromFileName(fileName);

    if (!terminalId) {
      continue;
    }

    if (!sanitizedActiveIds.has(terminalId)) {
      fs.rmSync(path.join(directoryPath, fileName), { force: true });
    }
  }
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
    globalThis.process.stderr.write(`[custom-vscode] Failed to overwrite terminal output for ${terminalId}: ${message}\n`);
  }
}

export function appendTerminalOutput(terminalId: string, chunk: string): void {
  try {
    fs.appendFileSync(getTerminalOutputFilePath(terminalId), chunk, { encoding: 'utf8' });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.process.stderr.write(`[custom-vscode] Failed to append terminal output for ${terminalId}: ${message}\n`);
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
