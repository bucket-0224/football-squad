'use strict';

// 경기 시작 전 프리뷰 팝업용 심판 — 실제 EPL/FIFA 심판 이름과, 실제로
// 회자되는 스타일을 짧게 한 줄로 요약한 특징이다. cardBias는 그 특징을
// 단순 장식이 아니라 실제로 게임에 반영하기 위한 파울/카드 확률
// 배율이다(simulate.js에서 사용) — 1.0이 기준, 엄격할수록 위로, 관대할수록
// 아래로.
const REFEREES = [
  { name: '마이클 올리버', trait: '카드를 아끼지 않고 엄격하게 판정하는 편입니다.', cardBias: 1.35 },
  { name: '앤서니 테일러', trait: '경기 흐름을 중시해 웬만하면 어드밴티지를 주는 편입니다.', cardBias: 0.95 },
  { name: '폴 티어니', trait: '판정이 빠르고 단호한 편입니다.', cardBias: 1.1 },
  { name: '크레이그 포슨', trait: '거친 몸싸움에도 비교적 관대한 편입니다.', cardBias: 0.75 },
  { name: '스튜어트 애트웰', trait: 'VAR 판독을 꼼꼼하고 길게 확인하는 편입니다.', cardBias: 1.15 },
  { name: '사이먼 후퍼', trait: '경고를 비교적 적게 주는 관대한 편입니다.', cardBias: 0.7 },
  { name: '데이비드 쿠트', trait: '몸싸움을 허용하는 폭이 넓은 편입니다.', cardBias: 0.85 },
  { name: '크리스 캐버너', trait: '일관된 기준으로 안정적인 판정을 보여줍니다.', cardBias: 1.0 },
  { name: '존 브룩스', trait: '경고가 잦고 카드가 많이 나오는 편입니다.', cardBias: 1.4 },
  { name: '피터 배스', trait: '사소한 반칙은 넘어가는 편입니다.', cardBias: 0.8 },
];

function pickReferee() {
  return REFEREES[Math.floor(Math.random() * REFEREES.length)];
}

module.exports = { REFEREES, pickReferee };
