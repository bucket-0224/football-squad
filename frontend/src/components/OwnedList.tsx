import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { activePoolIds, activeSquad, upLevel, upgradedCard } from '../game/cards';
import PlayerCard from './PlayerCard';
import type { CatalogPlayer } from '../types';

type SortKey = 'ovr' | 'pos' | 'name' | 'price';

const POS_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, ATT: 3 };
const SORTERS: Record<SortKey, (a: CatalogPlayer, b: CatalogPlayer) => number> = {
  ovr: (a, b) => b.ovr - a.ovr,
  pos: (a, b) => (POS_ORDER[a.line] ?? 9) - (POS_ORDER[b.line] ?? 9) || b.ovr - a.ovr,
  name: (a, b) => a.name.localeCompare(b.name),
  price: (a, b) => (b.price || 0) - (a.price || 0),
};

export default function OwnedList({
  onEnhance,
  onDetail,
}: {
  onEnhance: (playerId: string) => void;
  onDetail: (playerId: string) => void;
}) {
  const { me, squadMode, catalog, sellPlayer } = useAppStore();
  const [q, setQ] = useState('');
  const [lineFilter, setLineFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('ovr');

  if (!me) return null;

  const starters = new Set(activeSquad(me, squadMode).starters.filter(Boolean));
  const pool = activePoolIds(me, squadMode)
    .map((id) => upgradedCard(me, catalog.get(id)))
    .filter((p): p is CatalogPlayer => !!p);
  const owned = pool
    .filter((p) => (!q || p.name.toLowerCase().includes(q.toLowerCase())) && (!lineFilter || p.line === lineFilter))
    .sort(SORTERS[sortKey]);

  const mainStarters = new Set((me.squad.starters || []).filter(Boolean));
  const pvpStarters = new Set((me.pvpSquad.starters || []).filter(Boolean));

  const onSell = async (p: CatalogPlayer) => {
    const lvl = upLevel(me, p.id);
    const inLineups = [
      mainStarters.has(p.id) ? '클럽 스쿼드 선발' : null,
      pvpStarters.has(p.id) ? '실전 스쿼드 선발' : null,
    ].filter(Boolean);
    const warn =
      (inLineups.length
        ? `\n⚠️ 현재 ${inLineups.join('과 ')}에 배치되어 있습니다. 판매하면 해당 자리는 빈 슬롯(유스 투입)이 됩니다.`
        : '') + (lvl ? `\n⚡ 강화 +${lvl} 단계도 함께 사라집니다.` : '');
    if (!confirm(`${p.name} 선수를 판매할까요?${warn}`)) return;
    try {
      const { coinsGained, perfBonusPct } = await sellPlayer(p.id);
      const bonus = perfBonusPct > 0 ? ` (실적 보너스 +${perfBonusPct}%)` : '';
      toast(`${p.name} 판매 완료 · 🪙${coinsGained.toLocaleString()}${bonus}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="owned-col">
      <h3>
        {squadMode === 'pvp' ? '뽑은 선수 ' : '보유 선수 '}
        <span id="owned-count" className="dim">
          ({owned.length}/{pool.length}명)
        </span>
      </h3>
      <div className="owned-controls">
        <input id="owned-search" type="search" placeholder="선수 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <select id="owned-line" value={lineFilter} onChange={(e) => setLineFilter(e.target.value)}>
          <option value="">전체</option>
          <option value="GK">GK</option>
          <option value="DEF">수비</option>
          <option value="MID">미드필더</option>
          <option value="ATT">공격</option>
        </select>
        <select id="owned-sort" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="ovr">OVR순</option>
          <option value="pos">포지션순</option>
          <option value="name">이름순</option>
          <option value="price">가치순</option>
        </select>
      </div>
      <div id="owned-list">
        {squadMode === 'pvp' && !pool.length ? (
          <p className="dim">아직 뽑은 카드가 없습니다. 뽑기 탭에서 카드를 획득하세요!</p>
        ) : !owned.length ? (
          <p className="dim">조건에 맞는 선수가 없습니다.</p>
        ) : (
          owned.map((p) => {
            const isStarter = starters.has(p.id);
            const lvl = upLevel(me, p.id);
            return (
              <div className="card-cell" key={p.id}>
                <PlayerCard player={p} size="sm" flag={isStarter ? '선발' : undefined} />
                <div className="cc-actions">
                  <button type="button" className="btn ghost small" onClick={() => onDetail(p.id)}>
                    ⓘ 상세
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => onEnhance(p.id)}>
                    ⚡{lvl ? `+${lvl}` : '강화'}
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => onSell(p)}>
                    판매 🪙{Math.round((p.price || 0) * 0.55).toLocaleString()}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
