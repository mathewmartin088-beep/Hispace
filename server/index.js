// Run a standalone Hispace server:  node server/index.js
// Env: PORT (default 3000), DATA_DIR (default ./data), ICE_SERVERS (JSON array, optional TURN)
const path = require('path');
const { startServer } = require('./server');

startServer({
  port: Number(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data')
}).then(({ urls }) => {
  console.log('\nHispace server is running. Friends can connect at:');
  urls.forEach((u) => console.log('  ' + u));
  console.log('');
}).catch((err) => {
  console.error('Could not start server:', err.message);
  process.exit(1);
});
