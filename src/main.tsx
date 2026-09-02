/** Browser entry point — mounts the React app into #root. */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './ui/App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker (production only) so the app is installable and
// works offline. Network-first, so it's transparent while online. `import.meta.env`
// is Vite-injected; cast to read PROD without pulling in vite/client types.
const isProd = (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true;
if ('serviceWorker' in navigator && isProd) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is best-effort */
    });
  });
}
