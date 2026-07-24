import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { upgradedCard } from '../../game/cards';
import PlayerCard from '../PlayerCard';
import HexChart from '../HexChart';
import OpponentSquadModal from '../OpponentSquadModal';
import MatchDetailModal from '../MatchDetailModal';
import type { LeaderboardRow, MatchRecord, SeasonHistoryEntry, SeasonStatus } from '../../types';

type SubTab = 'board' | 'top' | 'perf';

export default function RankTab() {
  const [sub, setSub] = useState<SubTab>('board');
  const [oppoUsername, setOppoUsername] = useState<string | null>(null);

  return (
    <div id="tab-rank" className="tab-panel">
      <nav className="sub-tabs">
        <button type="button" className={sub === 'board' ? 'active' : ''} onClick={() => setSub('board')}>
          전체 랭킹
        </button>
        <button type="button" className={sub === 'top' ? 'active' : ''} onClick={() => setSub('top')}>
          득점왕 · 도움왕
        </button>
        <button type="button" className={sub === 'perf' ? 'active' : ''} onClick={() => setSub('perf')}>
          팀 성적
        </button>
      </nav>
      <div className="rank-sub" style={{ display: sub === 'board' ? undefined : 'none' }}>
        <BoardSub onViewSquad={setOppoUsername} />
      </div>
      <div className="rank-sub" style={{ display: sub === 'top' ? undefined : 'none' }}>
        {sub === 'top' && <TopPerformersSub />}
      </div>
      <div className="rank-sub" style={{ display: sub === 'perf' ? undefined : 'none' }}>
        {sub === 'perf' && <TeamRecordSub />}
      </div>
      {oppoUsername && <OpponentSquadModal username={oppoUsername} onClose={() => setOppoUsername(null)} />}
    </div>
  );
}

function BoardSub({ onViewSquad }: { onViewSquad: (username: string) => void }) {
  const me = useAppStore((s) => s.me);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [detailMatchId, setDetailMatchId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ leaderboard: LeaderboardRow[] }>('/api/leaderboard'),
      api.get<{ matches: MatchRecord[] }>('/api/matches'),
    ])
      .then(([lb, m]) => {
        setLeaderboard(lb.leaderboard);
        setMatches(m.matches);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  }, []);

  if (!me) return null;

  return (
    <div className="rank-layout">
      <div>
        <h3>🏆 랭킹</h3>
        <table className="data-table" id="leaderboard-table">
          <thead>
            <tr>
              <th>#</th>
              <th>구단</th>
              <th>승점</th>
              <th>승-무-패</th>
              <th>OVR</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map((row, i) => (
              <tr key={row.username} style={row.username === me.username ? { color: 'var(--gold)' } : undefined}>
                <td>{i + 1}</td>
                <td>
                  {row.clubName} <span className="dim small-text">({row.username})</span>
                </td>
                <td className="num">{row.points}</td>
                <td>
                  {row.record.w}-{row.record.d}-{row.record.l}
                </td>
                <td>{row.ovr}</td>
                <td>
                  {row.username !== me.username && (
                    <button type="button" className="btn ghost small" onClick={() => onViewSquad(row.username)}>
                      🔍 스쿼드
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3>📋 최근 경기</h3>
        <div id="history-list">
          {!matches.length ? (
            <p className="dim">아직 경기 기록이 없습니다.</p>
          ) : (
            matches.map((m) => {
              const isHome = m.homeUserId === me.id;
              const my = isHome ? m.score.home : m.score.away;
              const opp = isHome ? m.score.away : m.score.home;
              const oppName = isHome ? m.awayName : m.homeName;
              const outcome = my > opp ? 'win' : my < opp ? 'loss' : 'draw';
              const label = { win: '승', loss: '패', draw: '무' }[outcome];
              const date = new Date(m.at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
              return (
                <div className="history-row" key={m.id} onClick={() => setDetailMatchId(m.id)}>
                  <span className={`h-outcome ${outcome}`}>{label}</span>
                  <span>vs {oppName}</span>
                  <span className="h-score">
                    {my} - {opp}
                  </span>
                  <span className="dim small-text">
                    {m.mode === 'ai' ? 'AI전' : '랭크'} · {date}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
      {detailMatchId && <MatchDetailModal matchId={detailMatchId} onClose={() => setDetailMatchId(null)} />}
    </div>
  );
}

function topPerformer(
  playerStats: Record<string, { goals: number; assists: number }>,
  catalog: ReturnType<typeof useAppStore.getState>['catalog'],
  field: 'goals' | 'assists',
  otherField: 'goals' | 'assists'
) {
  const entries = Object.entries(playerStats).filter(([, s]) => (s[field] || 0) > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    const diff = b[1][field] - a[1][field];
    if (diff) return diff;
    const diff2 = (b[1][otherField] || 0) - (a[1][otherField] || 0);
    if (diff2) return diff2;
    const pa = catalog.get(a[0]);
    const pb = catalog.get(b[0]);
    return pa && pb ? pa.name.localeCompare(pb.name) : 0;
  });
  const [id, stat] = entries[0];
  return { id, stat };
}

function PerfCard({
  title,
  icon,
  entry,
}: {
  title: string;
  icon: string;
  entry: { id: string; stat: { goals: number; assists: number } } | null;
}) {
  const { me, catalog } = useAppStore();
  if (!entry || !me) {
    return (
      <div className="perf-card">
        <h4>
          {icon} {title}
        </h4>
        <p className="dim">이번 시즌 기록이 없습니다.</p>
      </div>
    );
  }
  const p = upgradedCard(me, catalog.get(entry.id));
  if (!p) return null;
  return (
    <div className="perf-card">
      <h4>
        {icon} {title}
      </h4>
      <div className="perf-body">
        <PlayerCard player={p} size="sm" stats />
        <div className="perf-chart">
          <HexChart attrs={p.attrs} />
          <div className="perf-stat dim small-text">
            ⚽ {entry.stat.goals || 0}골 · 🅰️ {entry.stat.assists || 0}도움
          </div>
        </div>
      </div>
    </div>
  );
}

function TopPerformersSub() {
  const { me, catalog } = useAppStore();
  if (!me) return null;
  const stats = me.playerStats || {};
  const scorer = topPerformer(stats, catalog, 'goals', 'assists');
  const assister = topPerformer(stats, catalog, 'assists', 'goals');
  return (
    <div className="top-performers">
      <PerfCard title="득점왕" icon="👑" entry={scorer} />
      <PerfCard title="도움왕" icon="🎯" entry={assister} />
    </div>
  );
}

function TeamRecordSub() {
  const me = useAppStore((s) => s.me);
  const [season, setSeason] = useState<SeasonStatus | null>(null);
  const [history, setHistory] = useState<SeasonHistoryEntry[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);

  useEffect(() => {
    Promise.all([
      api.get<{ season: SeasonStatus; history: SeasonHistoryEntry[] }>('/api/season'),
      api.get<{ leaderboard: LeaderboardRow[] }>('/api/leaderboard'),
    ])
      .then(([s, lb]) => {
        setSeason(s.season);
        setHistory(s.history);
        setLeaderboard(lb.leaderboard);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  }, []);

  if (!me || !season) return null;
  const myIdx = leaderboard.findIndex((r) => r.username === me.username);
  const top5 = leaderboard.slice(0, 5);
  const lastTop = history[0]?.top[0];

  return (
    <div id="team-record">
      <div className="season-banner">
        <div>
          <span className="season-num">시즌 {season.number}</span>
        </div>
        <div className="dim">{season.daysRemaining}일 후 시즌 종료 (30일 주기)</div>
      </div>
      <div className="team-grid">
        <div className="team-block">
          <h4>내 성적</h4>
          <div className="rating-cell-row">
            <div className="rating-cell">
              <div className="rc-label">순위</div>
              <div className="rc-value">{myIdx >= 0 ? '#' + (myIdx + 1) : '-'}</div>
            </div>
            <div className="rating-cell ovr">
              <div className="rc-label">승점</div>
              <div className="rc-value">{me.points}</div>
            </div>
            <div className="rating-cell">
              <div className="rc-label">전적</div>
              <div className="rc-value">
                {me.record.w}-{me.record.d}-{me.record.l}
              </div>
            </div>
          </div>
        </div>
        <div className="team-block">
          <h4>이번 시즌 TOP 5</h4>
          <ol className="mini-board">
            {top5.length ? (
              top5.map((r) => (
                <li key={r.username} style={r.username === me.username ? { color: 'var(--gold)' } : undefined}>
                  {r.clubName} <span className="dim small-text">({r.username})</span> — {r.points}점
                </li>
              ))
            ) : (
              <li className="dim">기록 없음</li>
            )}
          </ol>
        </div>
        <div className="team-block">
          <h4>지난 시즌 우승</h4>
          <p>
            {lastTop ? (
              <>
                {lastTop.clubName} <span className="dim small-text">({lastTop.username})</span> — {lastTop.points}점
              </>
            ) : (
              <span className="dim">아직 종료된 시즌이 없습니다.</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
