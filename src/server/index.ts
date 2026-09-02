/**
 * Entry point for the optional HTTP deployment of the modeler's API.
 *
 * Run with `npm run serve` (or `npx tsx src/server/index.ts`). Reads `PORT`
 * from the environment (default 5178), starts the Express app built by
 * {@link createServer}, and logs the URLs of the health, docs and OpenAPI
 * endpoints. The browser app never imports this file.
 */

import { createServer } from './app';
import { PRODUCT_NAME } from '../branding';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 5178;
// Loopback by default — the API is unauthenticated, so binding all interfaces
// would expose full read/write/delete to the local network. Set HOST=0.0.0.0
// explicitly (behind auth/a reverse proxy) to expose it.
const HOST = process.env.HOST ?? '127.0.0.1';

const app = createServer();
const server = app.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
   
  console.log(
    [
      `${PRODUCT_NAME} API listening on ${base}`,
      `  health   ${base}/health`,
      `  OpenAPI  ${base}/openapi.json`,
      `  docs     ${base}/docs`,
      `  REST     ${base}/api/projects`,
      `  OSLC     ${base}/oslc/catalog`,
    ].join('\n'),
  );
});

// Graceful shutdown on the usual signals.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
