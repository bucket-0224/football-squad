// 프론트엔드(정적 파일)와 백엔드(API 서버)가 서로 다른 origin
// (다른 포트/호스트)에서 서빙되므로 백엔드 주소를 명시해야 합니다.
// 같은 도메인으로 리버스 프록시(nginx 등)를 태운다면 둘 다 ''로 비워두세요.
//
// 로컬 개발 기본값: 백엔드가 localhost:3000에서 떠 있다고 가정.
// EC2 배포 시 아래 값을 실제 호스트로 바꾸세요.
//   API_BASE: 'http://your-ec2-host:3000',
//   WS_BASE: 'ws://your-ec2-host:3000',
window.APP_CONFIG = {
  API_BASE: 'http://localhost:3000',
  WS_BASE: 'ws://localhost:3000',
};
