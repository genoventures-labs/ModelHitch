import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/react/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // React stays a peer dependency of the `modelhitch/react` entry — never
  // bundle it.
  external: ['react', 'react/jsx-runtime'],
});
