# ⚽ 풋볼 스쿼드 (Football Squad)

축구 스쿼드 빌딩 + 실시간 대전 웹게임. 실제 8개 리그의 클럽·선수로 스쿼드를 꾸리고, 카드를 뽑고 강화해 다른 유저와 90분 탑뷰 경기를 치릅니다.

📖 **게임 가이드**: [docs/](docs/README.md) (GitBook 호환)

## 실행

```bash
npm install
npm start          # http://localhost:3000
```

선수 카드 이미지(선택):

```bash
node scripts/fetch-player-images.js   # footyrenders/TSDB에서 다운로드
python3 scripts/crop-upper-body.py    # 상체 크롭 정규화 (Pillow 필요)
```

## 구조

```
server/            Express + WebSocket 서버
  index.js         REST API (인증·스쿼드·이적·팩·강화·예측)
  matchmaking.js   실시간 매치·작전타임·관전 (ws)
  game/            경기 시뮬레이션·포메이션
  data/            선수 카탈로그·동적 팀(위키+TSDB 로스터)
public/            클라이언트 (vanilla JS)
  app.js           UI + 탑뷰 중계 엔진 (EPL 규칙 연출)
scripts/           이미지 수집/크롭 도구
docs/              게임 가이드 (GitBook)
```

## 특징

- 실시간 탑뷰 중계: 오프사이드·코너킥(Law 17)·수비벽·VAR·경고 누적 퇴장·백패스 룰·어드밴티지까지 EPL 규칙 기반
- 시뮬레이션은 EPL 실측 통계에 튜닝 (경기당 골 ~2.9, PK 전환율 ~76%, 레드 ~0.2회)
- 동적 팀: 142개 실클럽 로스터를 Wikipedia+TheSportsDB에서 수집
- 카드 팩·강화(+5)·2단계 이적 협상·실경기 승부 예측·관전 모드

## 데이터 출처

선수/팀 데이터와 이미지는 TheSportsDB, Wikipedia, footyrenders에서 가져오며 개인·로컬 사용 목적입니다.
