'use strict';

// pm2 process definitions for the EC2 host. Both apps run on the same
// instance on separate ports (backend:3000, frontend:8080).
//   pm2 startOrReload ecosystem.config.js --update-env
module.exports = {
  apps: [
    {
      name: 'football-squad-backend',
      cwd: __dirname + '/backend',
      script: 'index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Pass through from the shell that runs `pm2 startOrReload ... --update-env`
        // (deploy.sh) — set the actual secret in /etc/environment on the EC2
        // host, never commit a real value here.
        ADMIN_KEY: process.env.ADMIN_KEY,
      },
    },
    {
      name: 'football-squad-frontend',
      cwd: __dirname + '/frontend',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
    },
  ],
};
