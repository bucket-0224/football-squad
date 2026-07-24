// Mirrors the vanilla frontend's frontend/config.js: reuse the current
// page's hostname so the same build works unmodified on localhost and on
// the EC2 deploy (backend always lives on the same host, port 3000).
// VITE_API_BASE/VITE_WS_BASE allow a local .env.local override (e.g. when
// running the Vite dev server against a differently-hosted backend).
const BACKEND_HOST = window.location.hostname;

export const API_BASE = import.meta.env.VITE_API_BASE || `http://${BACKEND_HOST}:3000`;
export const WS_BASE = import.meta.env.VITE_WS_BASE || `ws://${BACKEND_HOST}:3000`;

// avatarUrl(예: "/img/avatars/xxx.png")은 백엔드가 직접 서빙하는 경로다 —
// 프론트엔드 자체 정적 빌드(frontend/dist) 기준 상대경로로 두면 마지막
// 배포 시점 스냅샷을 가리켜서, 그 사이 새로 올린 프로필 사진은 다음 배포
// 전까지 깨진 이미지로 보인다. 항상 API_BASE(백엔드) 기준으로 풀어준다.
export function avatarSrc(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  return avatarUrl.startsWith('http') ? avatarUrl : `${API_BASE}${avatarUrl}`;
}
