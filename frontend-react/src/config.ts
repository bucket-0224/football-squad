// Mirrors the vanilla frontend's frontend/config.js: reuse the current
// page's hostname so the same build works unmodified on localhost and on
// the EC2 deploy (backend always lives on the same host, port 3000).
// VITE_API_BASE/VITE_WS_BASE allow a local .env.local override (e.g. when
// running the Vite dev server against a differently-hosted backend).
const BACKEND_HOST = window.location.hostname;

export const API_BASE = import.meta.env.VITE_API_BASE || `http://${BACKEND_HOST}:3000`;
export const WS_BASE = import.meta.env.VITE_WS_BASE || `ws://${BACKEND_HOST}:3000`;
