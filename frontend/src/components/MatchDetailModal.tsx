import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { toast } from '../store/useToastStore';
import { COORDS } from '../game/formationCoords';
import MatchAnalysis from './MatchAnalysis';
import type { MatchContribution, MatchDetail } from '../types';

// 경기별로 안정적이지만 서로 다른 히트맵을 만들기 위한 결정론적 시드 —
// 이 세션 전반에서 쓰는 "이름+salt 기반 안정 지터" 패턴과 동일 (players.js의
// seededRand). 실제 프레임 단위 위치 로그는 남기지 않으므로, 그 선수가 이번
// 경기에 실제로 배치됐던 포메이션 슬롯 좌표를 중심으로 점유율에 비례해
// 퍼뜨리는 방식으로 "게임 데이터 기반"을 유지한다.
function mulberry32(seed: number) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

interface HeatPoint {
  x: number;
  y: number;
  w: number;
}

function heatPoints(matchId: string, playerId: string, cx: number, cy: number, possPct: number, goals: number): HeatPoint[] {
  const rand = mulberry32(hashStr(matchId + ':' + playerId));
  const spread = 8 + (possPct / 100) * 16;
  const pts: HeatPoint[] = [{ x: cx, y: cy, w: 1 }];
  for (let i = 0; i < 16; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = rand() * spread;
    pts.push({
      x: Math.max(4, Math.min(96, cx + Math.cos(ang) * dist)),
      y: Math.max(4, Math.min(96, cy + Math.sin(ang) * dist * 0.75)),
      w: 0.35 + rand() * 0.55,
    });
  }
  // 득점 장면 — 상대 골문(공격 방향 y=100) 근처에 가중치 높은 점을 추가한다.
  for (let g = 0; g < goals; g++) {
    const ang = rand() * Math.PI - Math.PI / 2;
    pts.push({
      x: Math.max(10, Math.min(90, 50 + Math.sin(ang) * 20)),
      y: Math.max(80, Math.min(96, 88 + rand() * 8)),
      w: 1,
    });
  }
  return pts;
}

function ContribRow({
  c,
  active,
  onSelect,
}: {
  c: MatchContribution;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={'contrib-row' + (active ? ' active' : '')} onClick={onSelect}>
      <span className="contrib-name">
        {c.name}
        {c.youth && <span className="dim small-text"> (유스)</span>}
      </span>
      <span className="contrib-pos dim small-text">{c.pos}</span>
      <span className="contrib-bar-track">
        <span className="contrib-bar-fill" style={{ width: c.score + '%' }} />
      </span>
      <span className="contrib-marks small-text">
        {c.goals > 0 && <span>⚽{c.goals > 1 ? `x${c.goals}` : ''}</span>}
        {c.assists > 0 && <span>🅰️{c.assists > 1 ? `x${c.assists}` : ''}</span>}
      </span>
    </button>
  );
}

export default function MatchDetailModal({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [selected, setSelected] = useState<{ side: 'home' | 'away'; c: MatchContribution } | null>(null);

  useEffect(() => {
    api
      .get<MatchDetail>('/api/matches/' + matchId)
      .then((d) => {
        setDetail(d);
        const top = [...d.contributions.home, ...d.contributions.away].sort((a, b) => b.score - a.score)[0];
        if (top) {
          const side = d.contributions.home.includes(top) ? 'home' : 'away';
          setSelected({ side, c: top });
        }
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  }, [matchId]);

  const points = useMemo(() => {
    if (!detail || !selected) return [];
    const formation =
      (selected.side === 'home' ? detail.match.homeFormation : detail.match.awayFormation) || '4-3-3';
    const coords = COORDS[formation] || COORDS['4-3-3'];
    const [cx, cy] = coords[selected.c.slot] || [50, 50];
    const possPct = (detail.match.possession && detail.match.possession[selected.side]) ?? 50;
    return heatPoints(matchId, selected.c.id || `slot${selected.c.slot}`, cx, cy, possPct, selected.c.goals);
  }, [detail, selected, matchId]);

  return (
    <div
      id="match-detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal match-detail-modal">
        <div className="picker-head">
          <span>🎯 경기 기록 상세</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        {!detail ? (
          <p className="dim">불러오는 중…</p>
        ) : (
          <>
            <div className="news-detail-score">
              {detail.match.homeName} <b>{detail.match.score.home} - {detail.match.score.away}</b> {detail.match.awayName}
            </div>
            <MatchAnalysis match={detail.match} />
            <div className="contrib-cols">
              <div className="contrib-col">
                <h4 className="dim small-text">{detail.match.homeName} 기여도</h4>
                {detail.contributions.home.map((c) => (
                  <ContribRow
                    key={c.id || c.slot}
                    c={c}
                    active={selected?.side === 'home' && selected.c.slot === c.slot}
                    onSelect={() => setSelected({ side: 'home', c })}
                  />
                ))}
              </div>
              <div className="contrib-col">
                <h4 className="dim small-text">{detail.match.awayName} 기여도</h4>
                {detail.contributions.away.map((c) => (
                  <ContribRow
                    key={c.id || c.slot}
                    c={c}
                    active={selected?.side === 'away' && selected.c.slot === c.slot}
                    onSelect={() => setSelected({ side: 'away', c })}
                  />
                ))}
              </div>
            </div>
            {selected && (
              <div className="heatmap-panel">
                <h4 className="dim small-text">
                  🔥 {selected.c.name} 히트맵 · {selected.c.pos} · OVR {selected.c.ovr}
                </h4>
                <div className="heatmap-pitch">
                  <div className="pitch-lines">
                    <div className="center-circle" />
                    <div className="halfway" />
                    <div className="box box-bottom" />
                    <div className="box box-top" />
                  </div>
                  {points.map((p, i) => (
                    <span
                      key={i}
                      className="heat-dot"
                      style={{ left: p.x + '%', bottom: p.y + '%', opacity: p.w * 0.55, width: 22 + p.w * 20, height: 22 + p.w * 20 }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
