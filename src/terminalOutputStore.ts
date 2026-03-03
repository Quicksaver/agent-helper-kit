import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OUTPUT_DIR_NAME = 'custom-vscode-terminal-output';
const OUTPUT_FILE_PREFIX = 'terminal-';
const OUTPUT_FILE_SUFFIX = '.log';

function getOutputDirectoryPath(): string {
  return path.join(os.tmpdir(), OUTPUT_DIR_NAME);
}

function ensureOutputDirectory(): string {
  const directoryPath = getOutputDirectoryPath();

  fs.mkdirSync(directoryPath, { recursive: true });

  return directoryPath;
}

function sanitizeTerminalId(terminalId: string): string {
  return terminalId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}

function getOutputFilePath(terminalId: string): string {
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
  fs.writeFileSync(getOutputFilePath(terminalId), '', { encoding: 'utf8' });
}

export function overwriteTerminalOutput(terminalId: string, output: string): void {
  fs.writeFileSync(getOutputFilePath(terminalId), output, { encoding: 'utf8' });
}

export function appendTerminalOutput(terminalId: string, chunk: string): void {
  fs.appendFileSync(getOutputFilePath(terminalId), chunk, { encoding: 'utf8' });
}

export function readTerminalOutput(terminalId: string): string {
  const filePath = getOutputFilePath(terminalId);

  if (!fs.existsSync(filePath)) {
    return '';
  }

  return fs.readFileSync(filePath, { encoding: 'utf8' });
}

export function removeTerminalOutputFile(terminalId: string): void {
  fs.rmSync(getOutputFilePath(terminalId), { force: true });
}
