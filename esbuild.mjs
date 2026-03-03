import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  bundle: true,
  entryPoints: [ './src/extension.ts' ],
  external: [ 'vscode' ],
  format: 'cjs',
  minify: !isWatch,
  outdir: 'dist',
  platform: 'node',
  sourcemap: isWatch,
  target: 'node22',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();

  // eslint-disable-next-line no-console
  console.log('Watching for changes...');
}
else {
  await esbuild.build(buildOptions);

  // eslint-disable-next-line no-console
  console.log('Build complete.');
}
