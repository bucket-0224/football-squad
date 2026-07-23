import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import PlayerCard from '../PlayerCard';
import NegotiationModal from '../NegotiationModal';
import type { CatalogPlayer } from '../../types';

const PAGE_SIZE = 60;

export default function MarketTab() {
  const { me, bootstrap, searchRemotePlayers } = useAppStore();
  const [q, setQ] = useState('');
  const [line, setLine] = useState('');
  const [enhancedOnly, setEnhancedOnly] = useState(false);
  const [buyoutOnly, setBuyoutOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [negoTarget, setNegoTarget] = useState<CatalogPlayer | null>(null);
  const [searching, setSearching] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLimit(PAGE_SIZE), [q, line, enhancedOnly, buyoutOnly]);

  if (!me || !bootstrap) return null;

  const ownedSet = new Set(me.owned);
  const qLower = q.trim().toLowerCase();
  const filtered = bootstrap.market.filter((p) => {
    if (p.youth) return false; // club-only academy fillers aren't for sale
    if (qLower && !p.name.toLowerCase().includes(qLower)) return false;
    if (line && p.line !== line) return false;
    if (enhancedOnly && !p.enhanced) return false;
    if (buyoutOnly && p.team) return false; // 바이아웃(FA)만: 구단 있는 선수 제외
    return true;
  });
  const visible = filtered.slice(0, limit);

  const onSearchRemote = async () => {
    setSearching(true);
    toast('실제 선수 DB에서 검색 중…');
    try {
      const { found, added } = await searchRemotePlayers(qLower);
      toast(found ? (added ? `${found}명 발견 · ${added}명 새로 등록되었습니다` : '이미 모두 등록된 선수입니다') : '해당 이름의 선수를 찾지 못했습니다');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div id="tab-market" className="tab-panel">
      <div className="market-toolbar">
        <input
          id="market-search"
          placeholder="선수 이름 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select id="market-line" value={line} onChange={(e) => setLine(e.target.value)}>
          <option value="">전체 포지션</option>
          <option value="GK">GK</option>
          <option value="DEF">수비수</option>
          <option value="MID">미드필더</option>
          <option value="ATT">공격수</option>
        </select>
        <label className="check-label">
          <input
            type="checkbox"
            id="market-enhanced"
            checked={enhancedOnly}
            onChange={(e) => setEnhancedOnly(e.target.checked)}
          />{' '}
          강화 카드만
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            id="market-buyout"
            checked={buyoutOnly}
            onChange={(e) => setBuyoutOnly(e.target.checked)}
          />{' '}
          바이아웃(FA)만
        </label>
      </div>
      <div id="market-list">
        {!visible.length && !qLower && <p className="dim">조건에 맞는 선수가 없습니다.</p>}
        {visible.map((p) => {
          const owned = ownedSet.has(p.id);
          return (
            <div className="card-cell" key={p.id}>
              <PlayerCard player={p} size="md" stats flag={p.team ? '' : 'FA'} />
              <div className="cc-price">🪙 {(p.price || 0).toLocaleString()}</div>
              <div className="cc-actions">
                {owned ? (
                  <span className="starter-tag">보유중</span>
                ) : (
                  <button type="button" className="btn small primary" onClick={() => setNegoTarget(p)}>
                    {p.team ? '협상 시작' : '바이아웃 협상'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length > limit && (
          <InfiniteScrollSentinel ref={sentinelRef} remaining={filtered.length - limit} onReach={() => setLimit((l) => l + PAGE_SIZE)} />
        )}
        {qLower.length >= 2 && (
          <div className="market-remote-row">
            <button type="button" className="btn ghost small" disabled={searching} onClick={onSearchRemote}>
              🔍 "{qLower}" 실제 선수 DB에서 검색
            </button>
          </div>
        )}
      </div>
      {negoTarget && <NegotiationModal player={negoTarget} onClose={() => setNegoTarget(null)} />}
    </div>
  );
}

function InfiniteScrollSentinel({
  remaining,
  onReach,
  ref,
}: {
  remaining: number;
  onReach: () => void;
  ref: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onReach();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className="dim small-text market-more">
      ⌄ 스크롤하면 {remaining}명 더 표시됩니다
    </div>
  );
}
