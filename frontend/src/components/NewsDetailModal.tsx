import type { MatchRecord } from '../types';

// possession/xG 점유율을 비교해 "어느 팀이 어떤 방식으로 경기를 지배했는지"를
// 한 줄로 요약한다 — xG 점유율이 볼 점유율보다 높으면 적은 볼 소유로도 기회를
// 효율적으로 만든 것(역습형), 낮으면 볼은 오래 잡았지만 기회로 잘 이어가지
// 못한 것(결정력 부족)으로 해석한다.
function playStyleVerdict(m: MatchRecord, home: string, away: string): string {
  const poss = m.possession;
  const xg = m.xg;
  if (!poss || !xg) return '이 경기는 전개 방식을 분석할 데이터가 충분하지 않습니다.';
  const possTotal = poss.home + poss.away || 1;
  const possHomeShare = poss.home / possTotal;
  const xgTotal = xg.home + xg.away || 1;
  const xgHomeShare = xg.home / xgTotal;
  const diff = xgHomeShare - possHomeShare;
  const possDominant = possHomeShare >= 0.5 ? home : away;
  const possDominantPct = Math.round(Math.max(possHomeShare, 1 - possHomeShare) * 100);

  if (Math.abs(diff) < 0.08) {
    return `${possDominant}가 볼 점유율(${possDominantPct}%)과 득점 기회 창출 모두에서 균형 잡힌 경기를 펼쳤다.`;
  }
  const efficientTeam = diff > 0 ? home : away;
  const otherTeam = diff > 0 ? away : home;
  if (efficientTeam === possDominant) {
    return `${efficientTeam}가 볼 점유율(${possDominantPct}%)과 결정력 모두 앞서며 경기를 완전히 지배했다.`;
  }
  return `${efficientTeam}는 볼 점유율에서는 밀렸지만 효율적인 역습으로 기회를 만들었고, ${otherTeam}는 볼은 오래 소유했지만 득점 기회로 잘 이어가지 못했다.`;
}

function finishNote(label: string, goals: number, xgVal: number): string | null {
  const diff = goals - xgVal;
  if (Math.abs(diff) < 0.5) return null;
  return diff > 0
    ? `${label} 결정력 우수 (실제 ${goals}골 · 기대 ${xgVal.toFixed(1)}골)`
    : `${label} 득점 기회 낭비 (실제 ${goals}골 · 기대 ${xgVal.toFixed(1)}골)`;
}

export default function NewsDetailModal({ match, onClose }: { match: MatchRecord; onClose: () => void }) {
  const home = match.homeName;
  const away = match.awayName;
  const poss = match.possession || { home: 50, away: 50 };
  const possHomePct = Math.round(poss.home);
  const xg = match.xg;
  const xgTotal = xg ? xg.home + xg.away || 1 : 1;
  const xgHomePct = xg ? Math.round((xg.home / xgTotal) * 100) : 50;

  const notes = xg
    ? [finishNote(home, match.score.home, xg.home), finishNote(away, match.score.away, xg.away)].filter(
        (x): x is string => !!x
      )
    : [];

  return (
    <div
      id="news-detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal news-detail-modal">
        <div className="picker-head">
          <span>📊 경기 분석</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="news-detail-score">
          {home} <b>{match.score.home} - {match.score.away}</b> {away}
        </div>
        <div className="poss-wrap">
          <span className="dim small-text">볼 점유율</span>
          <div className="poss-bar">
            <div className="poss-home" style={{ width: possHomePct + '%' }} />
          </div>
          <div className="poss-nums">
            <span>{home} {possHomePct}%</span>
            <span>{100 - possHomePct}% {away}</span>
          </div>
        </div>
        {xg && (
          <div className="poss-wrap">
            <span className="dim small-text">기대 득점(xG) 비중 · 홈 {xg.home.toFixed(1)} - {xg.away.toFixed(1)} 원정</span>
            <div className="poss-bar xg-bar">
              <div className="poss-home" style={{ width: xgHomePct + '%' }} />
            </div>
            <div className="poss-nums">
              <span>{home} {xgHomePct}%</span>
              <span>{100 - xgHomePct}% {away}</span>
            </div>
          </div>
        )}
        <div className="news-detail-verdict">{playStyleVerdict(match, home, away)}</div>
        {notes.length > 0 && (
          <ul className="news-detail-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
