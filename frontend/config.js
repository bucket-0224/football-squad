// 프론트엔드(정적 파일)와 백엔드(API 서버)가 같은 호스트의 다른 포트
// (backend:3000)에서 뜬다고 가정하고, 현재 페이지의 hostname을 그대로
// 재사용합니다. 로컬 개발(localhost:8080)이든 EC2 배포(ec2-host:8080)든
// 코드 수정 없이 동작하며, 배포 시 git reset으로 파일이 덮어써져도
// 값이 깨지지 않습니다.
//
// 백엔드가 다른 호스트에 있거나 리버스 프록시(nginx 등)로 같은 도메인에
// 태운다면 아래 값을 직접 지정하세요 (프록시의 경우 둘 다 '').
const BACKEND_HOST = location.hostname;
window.APP_CONFIG = {
  API_BASE: `http://${BACKEND_HOST}:3000`,
  WS_BASE: `ws://${BACKEND_HOST}:3000`,
};
