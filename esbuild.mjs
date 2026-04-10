import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionBuildOptions = {
  bundle: true,
  entryPoints: [ './src/extension.ts' ],
  // Keep runtime dependencies like `recheck` bundled.
  // The VSIX build uses `vsce --no-dependencies`, so marking them external
  // leaves Node `require(...)` calls unresolved after installation.
  external: [ 'vscode' ],
  format: 'cjs',
  minify: !isWatch,
  outdir: 'dist',
  platform: 'node',
  sourcemap: isWatch,
  target: 'node22',
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuildOptions = {
  bundle: true,
  entryPoints: [ './src/webviews/shellCommandsPanelWebview.ts' ],
  format: 'iife',
  minify: !isWatch,
  outdir: 'dist/webviews',
  platform: 'browser',
  sourcemap: isWatch,
  target: 'es2023',
};

if (isWatch) {
  const [ extensionContext, webviewContext ] = await Promise.all([
    esbuild.context(extensionBuildOptions),
    esbuild.context(webviewBuildOptions),
  ]);

  await Promise.all([
    extensionContext.watch(),
    webviewContext.watch(),
  ]);

  // eslint-disable-next-line no-console
  console.log('Watching for changes...');
}
else {
  await Promise.all([
    esbuild.build(extensionBuildOptions),
    esbuild.build(webviewBuildOptions),
  ]);

  // eslint-disable-next-line no-console
  console.log('Build complete.');
}
