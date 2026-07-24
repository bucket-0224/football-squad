# ⚽ FC Management

축구 스쿼드 빌딩 + 실시간 대전 웹게임. 실제 8개 리그의 클럽·선수로 스쿼드를 꾸리고, 카드를 뽑고 강화해 다른 유저와 90분 탑뷰 경기를 치릅니다.

📖 **게임 가이드**: [docs/](docs/README.md) (GitBook 호환)

## 실행

백엔드(API 서버)와 프론트엔드(정적 클라이언트)는 완전히 분리된 프로젝트입니다. 각각 따로 설치·실행하세요.

```bash
# 백엔드 (http://localhost:3000)
cd backend
npm install
npm start

# 프론트엔드 (http://localhost:8080, 별도 터미널)
cd frontend
npm start
```

`frontend/config.js`는 접속한 호스트의 3000번 포트를 백엔드로 자동 사용하므로
로컬/EC2 모두 별도 수정이 필요 없습니다. 백엔드를 다른 호스트에 두거나
리버스 프록시를 쓴다면 `frontend/config.js`를 직접 수정하세요.

선수 카드 이미지(선택, 저장소 루트에서 실행):

```bash
node scripts/fetch-player-images.js   # footyrenders/TSDB에서 다운로드
python3 scripts/crop-upper-body.py    # 상체 크롭 정규화 (Pillow 필요)
```

## 구조

```
backend/           Express + WebSocket 서버 (독립 npm 프로젝트)
  index.js         REST API (인증·스쿼드·이적·팩·강화·예측)
  matchmaking.js   실시간 매치·작전타임·관전 (ws)
  game/            경기 시뮬레이션·포메이션
  data/            선수 카탈로그·동적 팀(위키+TSDB 로스터), db.json
frontend/          클라이언트 (vanilla JS, 독립 npm 프로젝트)
  app.js           UI + 탑뷰 중계 엔진 (EPL 규칙 연출)
  config.js        백엔드 API 주소 설정
  server.js        정적 파일 서버 (의존성 없음)
scripts/           이미지 수집/크롭 도구
docs/              게임 가이드 (GitBook)
```

배포 시 `backend/`는 DB와 함께, `frontend/`는 정적 파일 서버로 각각 EC2에
올리면 됩니다. 같은 인스턴스에 둘 다 올릴 경우 서로 다른 포트를 쓰게 되므로
백엔드의 `CORS_ORIGIN` 환경변수를 프론트엔드 주소로 설정하세요(비워두면 `*` 허용).

`main`에 push하면 GitHub Actions가 EC2로 자동 배포합니다. 최초 설정과 필요한
repo secrets는 [DEPLOY.md](DEPLOY.md) 참고.

## 특징

- 실시간 탑뷰 중계: 오프사이드·코너킥(Law 17)·수비벽·VAR·경고 누적 퇴장·백패스 룰·어드밴티지까지 EPL 규칙 기반
- 시뮬레이션은 EPL 실측 통계에 튜닝 (경기당 골 ~2.9, PK 전환율 ~76%, 레드 ~0.2회)
- 동적 팀: 142개 실클럽 로스터를 Wikipedia+TheSportsDB에서 수집
- 카드 팩·강화(+5)·2단계 이적 협상·실경기 승부 예측·관전 모드

## 데이터 출처

선수/팀 데이터와 이미지는 TheSportsDB, Wikipedia, footyrenders에서 가져오며 개인·로컬 사용 목적입니다.
