import { _boot } from './app.js';

_boot().catch(err => {
  console.error('InfraWatch boot failed:', err);
  document.body.innerHTML = `<div style="color:#FF6677;padding:2rem;font-family:monospace">
    Boot error: ${err.message}<br><small>${err.stack}</small>
  </div>`;
});
