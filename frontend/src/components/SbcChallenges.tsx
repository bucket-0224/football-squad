import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { api } from '../api/client';
import { upgradedCard } from '../game/cards';
import PlayerCard, { EmptySlotCard } from './PlayerCard';
import type { CatalogPlayer, SbcChallenge, User } from '../types';

// 라인 그룹핑은 backend/game/formations.js의 LINE과 정확히 같은 기준을
// 써야 attLine84/defLine82 미리보기가 서버 판정과 어긋나지 않는다.
const LINE_OF: Record<string, 'GK' | 'DEF' | 'MID' | 'ATT'> = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
};

function leagueMap(teams: { name: string; league?: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  teams.forEach((t) => {
    if (t.league) m.set(t.name, t.league);
  });
  return m;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
}

function maxCount<T>(items: T[], keyFn: (t: T) => string | null | undefined): number {
  const counts = new Map<string, number>();
  items.forEach((it) => {
    const k = keyFn(it);
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  let max = 0;
  counts.forEach((v) => {
    if (v > max) max = v;
  });
  return max;
}

interface Resolved {
  p: CatalogPlayer;
  slotPos: string;
}

// backend/game/sbc.js의 CHALLENGE_TEMPLATES와 같은 기준으로 유지되어야
// 한다 — 여기는 제출 전 미리보기 전용이고, 최종 판정은 언제나 서버가
// 다시 한다(evaluate). 조건식 하나가 바뀌면 양쪽 다 고쳐야 한다.
function previewCheck(templateId: string, resolved: Resolved[], leagues: Map<string, string>): { ok: boolean; detail: string } {
  const players = resolved.map((r) => r.p);
  switch (templateId) {
    case 'sameLeague4': {
      const n = maxCount(players, (p) => (p.team && leagues.get(p.team)) || null);
      return { ok: n >= 4, detail: `현재 ${n}/4명` };
    }
    case 'sameTeam3': {
      const n = maxCount(players, (p) => p.team);
      return { ok: n >= 3, detail: `현재 ${n}/3명` };
    }
    case 'sameNation4': {
      const n = maxCount(players, (p) => p.flag);
      return { ok: n >= 4, detail: `현재 ${n}/4명` };
    }
    case 'avgOvr82': {
      const a = avg(players.map((p) => p.ovr));
      return { ok: a >= 82, detail: `현재 평균 ${a.toFixed(1)}` };
    }
    case 'avgOvrUnder75': {
      const a = avg(players.map((p) => p.ovr));
      return { ok: a <= 75, detail: `현재 평균 ${a.toFixed(1)}` };
    }
    case 'attLine84': {
      const inLine = resolved.filter((r) => LINE_OF[r.slotPos] === 'ATT');
      const a = avg(inLine.map((r) => r.p.ovr));
      return { ok: inLine.length > 0 && a >= 84, detail: inLine.length ? `현재 평균 ${a.toFixed(1)}` : '해당 라인에 배치된 선수 없음' };
    }
    case 'defLine82': {
      const inLine = resolved.filter((r) => LINE_OF[r.slotPos] === 'DEF');
      const a = avg(inLine.map((r) => r.p.ovr));
      return { ok: inLine.length > 0 && a >= 82, detail: inLine.length ? `현재 평균 ${a.toFixed(1)}` : '해당 라인에 배치된 선수 없음' };
    }
    default:
      return { ok: false, detail: '' };
  }
}

export default function SbcChallenges() {
  const { me, bootstrap, catalog } = useAppStore();
  const [challenges, setChallenges] = useState<SbcChallenge[]>([]);
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [starters, setStarters] = useState<(string | null)[]>(new Array(11).fill(null));
  const [pickSlot, setPickSlot] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ challenges: SbcChallenge[]; formation: string; slots: string[] }>('/api/sbc')
      .then((r) => {
        if (!alive) return;
        setChallenges(r.challenges);
        setSlots(r.slots);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const leagues = useMemo(() => leagueMap(bootstrap?.teams || []), [bootstrap]);

  const ownedCards = useMemo(() => {
    if (!me) return [];
    return (me.owned || [])
      .map((id) => upgradedCard(me, catalog.get(id)))
      .filter((p): p is CatalogPlayer => !!p);
  }, [me, catalog]);

  if (!me) return null;

  const active = challenges.find((c) => c.id === activeId) || null;

  const openChallenge = (c: SbcChallenge) => {
    setActiveId(c.id);
    setStarters(new Array(11).fill(null));
    setPickSlot(null);
  };

  // 요청: "LW, CB, RB, LB, CB 등등에 대한 슬롯은 해당 슬롯을 소화가 가능한
  // ... 자원을 넣을 수 있게" — 정확히 같은 포지션 카드만 보여주면 그
  // 정확한 포지션 카드가 없는 클럽은 슬롯을 채울 수가 없었다. 슬롯의
  // 라인(DEF/MID/ATT/GK, 위 LINE_OF)이 같은 카드는 전부 후보로 보여주되,
  // 그 슬롯과 정확히 같은 포지션인 카드를 목록 맨 위로 올려 실제 스쿼드
  // 편집(PickerModal)과 같은 "정확한 포지션 우선" 정렬을 유지한다.
  const candidatesFor = (slotIdx: number) => {
    const pos = slots[slotIdx];
    const line = LINE_OF[pos] || 'MID';
    const usedElsewhere = new Set(starters.filter((_, i) => i !== slotIdx).filter(Boolean) as string[]);
    return ownedCards
      .filter((p) => (LINE_OF[p.pos] || 'MID') === line)
      .filter((p) => !usedElsewhere.has(p.id))
      .sort((a, b) => {
        const exact = (p: CatalogPlayer) => (p.pos === pos ? 1 : 0);
        return exact(b) - exact(a) || b.ovr - a.ovr;
      });
  };

  const assign = (slotIdx: number, playerId: string) => {
    setStarters((prev) => {
      const next = [...prev];
      // 이미 다른 슬롯에 있던 카드면 그 슬롯은 비운다 — 로컬 챌린지
      // 빌더라 실제 스쿼드에는 영향이 없다.
      const dupIdx = next.findIndex((id, i) => id === playerId && i !== slotIdx);
      if (dupIdx >= 0) next[dupIdx] = null;
      next[slotIdx] = playerId;
      return next;
    });
    setPickSlot(null);
  };

  const clearSlot = (slotIdx: number) => {
    setStarters((prev) => {
      const next = [...prev];
      next[slotIdx] = null;
      return next;
    });
  };

  const resolved: (Resolved | null)[] = starters.map((id, i) => {
    if (!id) return null;
    const p = ownedCards.find((c) => c.id === id);
    return p ? { p, slotPos: slots[i] || '' } : null;
  });
  const filledCount = resolved.filter(Boolean).length;
  const preview =
    active && filledCount === 11
      ? previewCheck(active.templateId, resolved.filter((r): r is Resolved => !!r), leagues)
      : null;

  const submit = async () => {
    if (!active) return;
    if (filledCount < 11) {
      toast('11명을 모두 배치해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.post<{ user: User }>('/api/sbc/submit', { challengeId: active.id, starters });
      useAppStore.getState().setMe(r.user);
      toast('🎯 챌린지 완료! 우편함에서 보상을 확인하세요.');
      setChallenges((prev) => prev.map((c) => (c.id === active.id ? { ...c, completed: true } : c)));
      setActiveId(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p className="dim small-text">불러오는 중...</p>;

  return (
    <div className="sbc-wrap">
      <div className="event-promo-banner sbc-banner">
        <span>🎯 오늘의 SBC 챌린지</span>
        <span className="dim small-text">카드는 소모되지 않습니다 — 조건만 만족하면 보상!</span>
      </div>
      <div className="sbc-challenge-grid">
        {challenges.map((c) => (
          <div key={c.id} className={'sbc-card' + (c.completed ? ' done' : '')}>
            <div className="sbc-card-label">{c.label}</div>
            <div className="dim small-text">{c.desc}</div>
            <div className="sbc-card-reward">🪙 {c.reward.coins ?? 0}</div>
            {c.completed ? (
              <span className="sbc-card-done-badge">완료</span>
            ) : (
              <button type="button" className="btn small primary" onClick={() => openChallenge(c)}>
                도전하기
              </button>
            )}
          </div>
        ))}
      </div>

      {active && (
        <div
          className="sbc-builder-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setActiveId(null);
          }}
        >
          <div className="sbc-builder">
            <div className="sbc-builder-head">
              <div>
                <b>{active.label}</b>
                <p className="dim small-text">{active.desc}</p>
              </div>
              <button type="button" className="btn ghost small" onClick={() => setActiveId(null)}>
                닫기
              </button>
            </div>
            <div className="sbc-slots">
              {slots.map((pos, i) => {
                const id = starters[i];
                const p = id ? ownedCards.find((c) => c.id === id) : null;
                return (
                  <button type="button" key={i} className="sbc-slot" onClick={() => setPickSlot(i)}>
                    {p ? <PlayerCard player={p} size="xs" /> : <EmptySlotCard pos={pos} />}
                  </button>
                );
              })}
            </div>
            {preview && (
              <div className={'sbc-preview' + (preview.ok ? ' ok' : ' no')}>
                {preview.ok ? '✅ 조건 충족!' : '❌ 조건 미충족'} — {preview.detail}
              </div>
            )}
            <button
              type="button"
              className="btn primary big"
              disabled={filledCount < 11 || submitting || !preview?.ok}
              onClick={submit}
            >
              제출
            </button>
          </div>
        </div>
      )}

      {pickSlot !== null && (
        <div
          className="sbc-picker-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPickSlot(null);
          }}
        >
          <div className="sbc-picker">
            <div className="sbc-picker-head">
              <b>선수 선택 — {slots[pickSlot]}</b>
              <button type="button" className="btn ghost small" onClick={() => setPickSlot(null)}>
                닫기
              </button>
            </div>
            {starters[pickSlot] && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  clearSlot(pickSlot);
                  setPickSlot(null);
                }}
              >
                슬롯 비우기
              </button>
            )}
            <div className="sbc-picker-list">
              {candidatesFor(pickSlot).length === 0 && (
                <p className="dim small-text">{slots[pickSlot]} 포지션 보유 카드가 없습니다.</p>
              )}
              {candidatesFor(pickSlot).map((p) => (
                <button type="button" key={p.id} className="sbc-picker-item" onClick={() => assign(pickSlot, p.id)}>
                  <PlayerCard player={p} size="xs" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
