import { serve } from '@hono/node-server';
import 'dotenv/config';
import app from './index.js';

const port = Number(process.env.PORT) || 3000;

console.log(`Rug Scanner starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Rug Scanner running at http://localhost:${port}`);
console.log(`  POST /scan — $0.05/scan (x402)`);
console.log(`  GET  /health — free`);
