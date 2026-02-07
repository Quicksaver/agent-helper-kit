import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  bundle: true,
  entryPoints: [ './src/extension.ts' ],
  external: [ 'vscode' ],
  format: 'cjs',
  minify: !isWatch,
  outfile: 'dist/extension.js',
  platform: 'node',
  sourcemap: isWatch,
  target: 'node22',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete.');
}
