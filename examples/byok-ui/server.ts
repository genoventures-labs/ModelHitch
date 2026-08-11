/**
 * Zero-config local bridge for the BYOK UI demo.
 *
 * Run: npm run server   (in examples/byok-ui)
 * Then: npm run dev     (in examples/byok-ui)
 *
 * Serves the deterministic mock provider at http://127.0.0.1:3939/v1 so the
 * UI works with no keys. Point `VITE_BRIDGE_MODEL` (or the App defaults) at
 * any real provider the bridge routes — e.g. start the studio bridge
 * (`npm run bridge` at the repo root) and use model "opencode-zen/big-pickle".
 */
import { createModelHitchServer, mockProvider } from '../../src/index.js';

const server = createModelHitchServer({
  providers: [mockProvider],
  defaultProviderId: 'mock',
  logger: (line) => console.log(line),
});

const { url } = await server.listen(3939, '127.0.0.1');
console.log(`BYOK bridge listening at ${url} (mock provider)`);
console.log('UI: npm run dev → http://localhost:5173');
