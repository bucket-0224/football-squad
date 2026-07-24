import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { toast } from '../../store/useToastStore';
import NewsDetailModal from '../NewsDetailModal';
import type { MatchRecord } from '../../types';

// 매치당 하나의 리포트 형식(속보/영상/라디오)을 매치 id로 결정 — 새로고침해도
// 같은 경기는 같은 형식을 유지하고, 목록 전체가 같은 모양으로 단조롭지 않게 한다.
const NEWS_FORMATS = [
  { tag: '속보', cls: 'breaking' },
  { tag: '📺 하이라이트', cls: 'video' },
  { tag: '📻 라디오 중계', cls: 'radio' },
];

function newsFormatFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NEWS_FORMATS[h % NEWS_FORMATS.length];
}

// 실제 경기 데이터(점수차·점유율·xG) 기반의 한 줄 코멘트 — 포맷별로 말투만 다르게.
function newsBlurb(
  m: MatchRecord,
  fmt: (typeof NEWS_FORMATS)[number],
  winnerName: string | null,
  loserName: string | null
) {
  const margin = Math.abs(m.score.home - m.score.away);
  const poss = m.possession || { home: 50, away: 50 };
  const dominance = Math.max(poss.home, poss.away);
  let line: string;
  if (margin === 0) {
    line = '양 팀 모두 승점을 하나씩 나눠 가졌다';
  } else if (margin >= 3) {
    line = `${winnerName}가 시종일관 경기를 압도하며 완승을 거뒀다`;
  } else if (dominance >= 58) {
    line = `${winnerName}가 볼 점유를 앞세워 ${loserName}을(를) 무너뜨렸다`;
  } else {
    line = `${winnerName}가 접전 끝에 ${loserName}을(를) 힘겹게 꺾었다`;
  }
  if (fmt.cls === 'radio') return `"${line}" — 현장 라디오 코멘트`;
  if (fmt.cls === 'video') return `${line} · 하이라이트 리포트`;
  return line;
}

export default function NewsTab() {
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [detail, setDetail] = useState<MatchRecord | null>(null);

  useEffect(() => {
    api
      .get<{ matches: MatchRecord[] }>('/api/news')
      .then((r) => setMatches(r.matches))
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div id="tab-news" className="tab-panel">
      <div id="news-list">
        {matches.map((m) => {
          const winner = m.score.home === m.score.away ? null : m.score.home > m.score.away ? 'home' : 'away';
          const home = m.homeName;
          const away = m.awayName;
          const teams =
            winner === 'home' ? (
              <>
                <b>{home}</b> {m.score.home} - {m.score.away} {away}
              </>
            ) : winner === 'away' ? (
              <>
                {home} {m.score.home} - {m.score.away} <b>{away}</b>
              </>
            ) : (
              <>
                {home} {m.score.home} - {m.score.away} {away} (무승부)
              </>
            );
          const fmt = newsFormatFor(m.id);
          const winnerName = winner === 'home' ? home : winner === 'away' ? away : null;
          const loserName = winner === 'home' ? away : winner === 'away' ? home : null;
          const blurb = newsBlurb(m, fmt, winnerName, loserName);
          return (
            <div className="news-item" key={m.id} onClick={() => setDetail(m)}>
              <div className="news-head">
                <span className={`news-badge ${fmt.cls}`}>{fmt.tag}</span>
                <span className="news-date">{new Date(m.at).toLocaleString()}</span>
              </div>
              <div className="news-teams">{teams}</div>
              <div className="news-blurb">{blurb}</div>
              <div className="news-detail-hint dim small-text">📊 상세보기</div>
            </div>
          );
        })}
      </div>
      {detail && <NewsDetailModal match={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
