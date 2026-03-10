import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

const BUMP_SCRIPT_SOURCE_PATH = path.join(process.cwd(), 'scripts', 'bump.sh');
const TERMINAL_UI_SOURCE_PATH = path.join(process.cwd(), 'scripts', 'lib', 'terminal-ui.sh');

const tempDirectories: string[] = [];

type TempRepo = {
  changelogPath: string;
  packageJsonPath: string;
  repoDir: string;
  scriptPath: string;
};

afterEach(() => {
  for (const tempDirectory of tempDirectories.splice(0)) {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
  }
});

function createTempRepo(version: string, changelog: string): TempRepo {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-helper-kit-bump-'));
  const scriptsDir = path.join(repoDir, 'scripts');
  const scriptPath = path.join(scriptsDir, 'bump.sh');
  const terminalUiPath = path.join(scriptsDir, 'lib', 'terminal-ui.sh');
  const packageJsonPath = path.join(repoDir, 'package.json');
  const changelogPath = path.join(repoDir, 'CHANGELOG.md');

  tempDirectories.push(repoDir);

  fs.mkdirSync(path.dirname(terminalUiPath), { recursive: true });
  fs.copyFileSync(BUMP_SCRIPT_SOURCE_PATH, scriptPath);
  fs.copyFileSync(TERMINAL_UI_SOURCE_PATH, terminalUiPath);
  fs.chmodSync(scriptPath, 0o755);

  fs.writeFileSync(packageJsonPath, `${JSON.stringify({
    name: 'temp-package',
    private: true,
    version,
  }, null, 2)}\n`);
  fs.writeFileSync(changelogPath, changelog);

  execFileSync('git', [ 'init' ], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', [ 'config', 'user.email', 'test@example.com' ], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', [ 'config', 'user.name', 'Test User' ], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', [ 'add', 'package.json', 'CHANGELOG.md', 'scripts' ], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', [ 'commit', '-m', 'Initial commit' ], { cwd: repoDir, stdio: 'ignore' });

  return {
    changelogPath,
    packageJsonPath,
    repoDir,
    scriptPath,
  };
}

function getReleaseDate(): string {
  return execFileSync('date', [ '+%Y-%m-%d' ], { encoding: 'utf8' }).trim();
}

function readPackageVersion(packageJsonPath: string): string {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string };

  return packageJson.version;
}

function runBump(repoDir: string, scriptPath: string, bumpType: 'major' | 'minor' | 'patch' = 'patch'): string {
  return execFileSync('bash', [ scriptPath, bumpType ], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  });
}

function runBumpProcess(repoDir: string, scriptPath: string, bumpType: 'major' | 'minor' | 'patch' = 'patch') {
  return spawnSync('bash', [ scriptPath, bumpType ], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  });
}

describe('bump.sh', () => {
  it('rolls unreleased entries even when the heading has trailing spaces and the file lacks a final newline', () => {
    const releaseDate = getReleaseDate();
    const repo = createTempRepo(
      '1.2.3',
      [
        '# Changelog',
        '',
        '## [Unreleased]  ',
        '',
        '### Fixed',
        '',
        '- Preserved the current unreleased notes.',
        '',
        '## [1.0.0] - 2026-03-01',
        '',
        '### Added',
        '',
        '- Initial release.',
      ].join('\n'),
    );

    runBump(repo.repoDir, repo.scriptPath);

    expect(readPackageVersion(repo.packageJsonPath)).toBe('1.2.4');
    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      `## [1.2.4] - ${releaseDate}`,
      '',
      '### Fixed',
      '',
      '- Preserved the current unreleased notes.',
      '',
      '## [1.0.0] - 2026-03-01',
      '',
      '### Added',
      '',
      '- Initial release.',
      '',
    ].join('\n'));
  });

  it('writes Version bump only for a whitespace-only unreleased body', () => {
    const releaseDate = getReleaseDate();
    const repo = createTempRepo(
      '2.0.0',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '   ',
        '\t',
      ].join('\n'),
    );

    runBump(repo.repoDir, repo.scriptPath);

    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      `## [2.0.1] - ${releaseDate}`,
      '',
      'Version bump only.',
      '',
    ].join('\n'));
  });

  it('keeps CHANGELOG.md terminated by exactly one newline when prior releases already end with one', () => {
    const releaseDate = getReleaseDate();
    const repo = createTempRepo(
      '2.1.0',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Fixed',
        '',
        '- Trim duplicate trailing blank lines.',
        '',
        '## [2.0.0] - 2026-03-09',
        '',
        '### Added',
        '',
        '- Existing release entry.',
        '',
      ].join('\n'),
    );
    const originalChangelog = fs.readFileSync(repo.changelogPath, 'utf8');

    expect(originalChangelog.endsWith('\n')).toBe(true);
    expect(originalChangelog.endsWith('\n\n')).toBe(false);

    runBump(repo.repoDir, repo.scriptPath);

    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      `## [2.1.1] - ${releaseDate}`,
      '',
      '### Fixed',
      '',
      '- Trim duplicate trailing blank lines.',
      '',
      '## [2.0.0] - 2026-03-09',
      '',
      '### Added',
      '',
      '- Existing release entry.',
      '',
    ].join('\n'));
  });

  it('normalizes CRLF changelog tails with extra trailing blank lines to one final newline', () => {
    const releaseDate = getReleaseDate();
    const repo = createTempRepo(
      '2.1.0',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Fixed',
        '',
        '- Trim CRLF changelog tails.',
        '',
        '## [2.0.0] - 2026-03-09',
        '',
        '### Added',
        '',
        '- Existing release entry.',
        '',
        '',
      ].join('\r\n'),
    );

    runBump(repo.repoDir, repo.scriptPath);

    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      `## [2.1.1] - ${releaseDate}`,
      '',
      '### Fixed',
      '',
      '- Trim CRLF changelog tails.',
      '',
      '## [2.0.0] - 2026-03-09',
      '',
      '### Added',
      '',
      '- Existing release entry.',
      '',
    ].join('\n'));
  });

  it('does not warn about /dev/tty when run without a controlling terminal', () => {
    const repo = createTempRepo(
      '2.0.0',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Fixed',
        '',
        '- Quiet non-interactive run.',
        '',
      ].join('\n'),
    );

    const result = runBumpProcess(repo.repoDir, repo.scriptPath);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('refuses to rewrite package.json or CHANGELOG.md when CHANGELOG.md is dirty', () => {
    const repo = createTempRepo(
      '3.4.5',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Fixed',
        '',
        '- Pending release note.',
        '',
      ].join('\n'),
    );
    const originalChangelog = fs.readFileSync(repo.changelogPath, 'utf8');

    fs.appendFileSync(repo.changelogPath, '<!-- dirty -->\n');

    expect(() => runBump(repo.repoDir, repo.scriptPath)).toThrowError(/uncommitted changes/u);
    expect(readPackageVersion(repo.packageJsonPath)).toBe('3.4.5');
    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe(`${originalChangelog}<!-- dirty -->\n`);
  });

  it('refuses to rewrite package.json or CHANGELOG.md when package.json is dirty', () => {
    const repo = createTempRepo(
      '3.4.5',
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Fixed',
        '',
        '- Pending release note.',
        '',
      ].join('\n'),
    );
    const originalChangelog = fs.readFileSync(repo.changelogPath, 'utf8');

    fs.appendFileSync(repo.packageJsonPath, ' ');

    expect(() => runBump(repo.repoDir, repo.scriptPath)).toThrowError(/uncommitted changes/u);
    expect(readPackageVersion(repo.packageJsonPath)).toBe('3.4.5');
    expect(fs.readFileSync(repo.changelogPath, 'utf8')).toBe(originalChangelog);
  });
});
