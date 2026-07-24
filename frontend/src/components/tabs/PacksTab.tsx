import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { api } from '../../api/client';
import PlayerCard from '../PlayerCard';
import type { CatalogPlayer, User } from '../../types';

interface PackResult {
  pack: string;
  player: CatalogPlayer;
  duplicate: boolean;
  unlocked: boolean;
  refund: number;
}

const PACK_META: Record<string, { img: string; desc: string; cls: string }> = {
  bronze: { img: '/img/packs/bronze.png', desc: 'OVR 79 이하', cls: 'pack-bronze' },
  silver: { img: '/img/packs/silver.png', desc: 'OVR 78~85', cls: 'pack-silver' },
  gold: { img: '/img/packs/gold.png', desc: 'OVR 84 이상', cls: 'pack-gold' },
  special: { img: '/img/packs/special.png', desc: 'OVR 86+ · 강화 카드 확률 UP', cls: 'pack-special' },
  icon: { img: '/img/packs/icon.png', desc: '레전드 아이콘 카드 확정', cls: 'pack-icon' },
};

const SPARK_COLORS = ['#ffd76e', '#ff7a7a', '#7ab8ff', '#9dff8a', '#e19bff'];

export default function PacksTab() {
  const { bootstrap, setMe } = useAppStore();
  const [results, setResults] = useState<PackResult[] | null>(null);
  const [lastPack, setLastPack] = useState<{ id: string; count: number } | null>(null);

  if (!bootstrap) return null;

  const openPack = async (packId: string, count: 1 | 5) => {
    setLastPack({ id: packId, count });
    try {
      const r = await api.post<{ user: User; results: PackResult[] }>('/api/packs/open', {
        pack: packId,
        count,
      });
      setMe(r.user);
      setResults(r.results);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div id="tab-packs" className="tab-panel">
      <div className="packs-intro dim">
        팩을 열어 무작위 선수를 영입하세요. 이미 보유한 선수가 나오면 판매가(55%)만큼 코인으로 전환됩니다.
      </div>
      <div id="pack-shelf">
        {bootstrap.packs.map((pk) => {
          const p = pk as { id: string; name: string; price: number };
          const meta = PACK_META[p.id] || { img: '', desc: '', cls: '' };
          return (
            <div className={'pack-tile ' + meta.cls} key={p.id}>
              {meta.img && <img className="pk-img" src={meta.img} alt="" />}
              <div className="pk-info">
                <span className="pk-name">{p.name}</span>
                <span className="pk-desc">{meta.desc}</span>
                <span className="pk-price">🪙 {p.price.toLocaleString()}</span>
              </div>
              <div className="pk-actions">
                <button type="button" className="btn small primary" onClick={() => openPack(p.id, 1)}>
                  1회 뽑기
                </button>
                <button type="button" className="btn small" onClick={() => openPack(p.id, 5)}>
                  5연속 🪙{(p.price * 5).toLocaleString()}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {results && (
        <PackRevealModal
          results={results}
          onAgain={() => lastPack && openPack(lastPack.id, lastPack.count as 1 | 5)}
          onClose={() => setResults(null)}
        />
      )}
    </div>
  );
}

function PackRevealModal({
  results,
  onAgain,
  onClose,
}: {
  results: PackResult[];
  onAgain: () => void;
  onClose: () => void;
}) {
  const best = useMemo(
    () => results.reduce((a, x) => (x.player.ovr > a.player.ovr ? x : a), results[0]),
    [results]
  );
  const showCeremony = best.player.ovr >= 80;
  const [ceremonyDone, setCeremonyDone] = useState(!showCeremony);
  // 국가 -> (사라짐) -> 포지션 -> (사라짐) -> 팀 로고(없으면 스킵) -> (사라짐)
  // 순서로 한 번에 하나씩만 보여준다 — activeStage가 null이 되는 순간이 곧
  // "사라짐" 구간이고, 세 아이템 모두 항상 마운트된 채 opacity만 토글되므로
  // (조건부 렌더가 아님) 사라지는 트랜지션이 실제로 재생된다.
  const [stage, setStage] = useState<'flag' | 'pos' | 'club' | null>(null);

  useEffect(() => {
    if (!showCeremony) return;
    setCeremonyDone(false);
    setStage(null);
    const HOLD_MS = 650; // 각 아이템이 완전히 보이는 시간
    const GAP_MS = 300; // 사라진 뒤 다음 아이템이 뜨기 전 공백
    const steps: Array<'flag' | 'pos' | 'club'> = best.player.teamLogo
      ? ['flag', 'pos', 'club']
      : ['flag', 'pos'];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let t = 300;
    steps.forEach((s) => {
      timers.push(setTimeout(() => setStage(s), t));
      t += HOLD_MS;
      timers.push(setTimeout(() => setStage(null), t));
      t += GAP_MS;
    });
    timers.push(setTimeout(() => setCeremonyDone(true), t));
    return () => timers.forEach(clearTimeout);
    // results identity changes on every new pack open (new array from the API)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const sparks = useMemo(
    () =>
      showCeremony
        ? Array.from({ length: 26 }, (_, i) => {
            const ang = Math.random() * Math.PI * 2;
            const dist = 60 + Math.random() * 120;
            return {
              dx: Math.cos(ang) * dist,
              dy: Math.sin(ang) * dist,
              color: SPARK_COLORS[i % SPARK_COLORS.length],
              delay: (Math.random() * 0.5).toFixed(2) + 's',
            };
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results]
  );

  const others = results.filter((x) => x !== best).sort((a, b) => (b.player.price || 0) - (a.player.price || 0));

  return (
    <div
      id="pack-reveal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && ceremonyDone) onClose();
      }}
    >
      <div id="pack-reveal">
      {showCeremony && !ceremonyDone ? (
        <div id="pack-ceremony">
          <div id="cere-sparks">
            {sparks.map((s, i) => (
              <span
                key={i}
                className="cere-spark"
                style={
                  {
                    '--dx': s.dx + 'px',
                    '--dy': s.dy + 'px',
                    background: s.color,
                    animationDelay: s.delay,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
          <div className="cere-items">
            <span className={'cere-item' + (stage === 'flag' ? ' on' : '')}>{best.player.flag || '🌍'}</span>
            <span className={'cere-item cere-pos' + (stage === 'pos' ? ' on' : '')}>{best.player.pos}</span>
            {best.player.teamLogo && (
              <img
                className={'cere-item cere-club' + (stage === 'club' ? ' on' : '')}
                src={best.player.teamLogo}
                alt=""
              />
            )}
          </div>
          <div className="cere-label dim">워크아웃 진행 중…</div>
        </div>
      ) : (
        <>
          <div id="pack-card-wrap" className={results.length > 1 ? 'multi' : ''}>
            {showCeremony ? (
              <PlayerCard player={best.player} size="md" stats />
            ) : (
              [...results]
                .sort((a, b) => (b.player.price || 0) - (a.player.price || 0))
                .map((x) => (
                  <PlayerCard
                    key={x.player.id}
                    player={x.player}
                    size={results.length > 1 ? 'sm' : 'md'}
                    stats={results.length === 1}
                  />
                ))
            )}
          </div>
          {showCeremony && (
            <div id="pack-rest">
              {others.map((x) => (
                <PlayerCard key={x.player.id} player={x.player} size="sm" />
              ))}
            </div>
          )}
          <div id="pack-result-text">
            <ResultText results={results} />
          </div>
          <div className="pack-reveal-actions">
            <button type="button" className="btn primary" onClick={onAgain}>
              한 번 더!
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              닫기
            </button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

function ResultText({ results }: { results: PackResult[] }) {
  if (results.length === 1) {
    const one = results[0];
    if (one.duplicate) {
      return (
        <>
          {one.player.name} — 이미 보유 중!<span className="sub">🪙 {one.refund.toLocaleString()} 코인으로 전환되었습니다</span>
        </>
      );
    }
    if (one.unlocked) {
      return (
        <>
          {one.player.name} — 실전 스쿼드 사용권 획득!
          <span className="sub">이미 보유한 선수지만 이제 실전(랭크) 스쿼드에 배치할 수 있습니다</span>
        </>
      );
    }
    const rare = one.player.enhanced ? '💎 잭팟! ' : '';
    return (
      <>
        {rare}
        {one.player.name} 영입!
        <span className="sub">
          {one.player.pos} · OVR {one.player.ovr} · 실전 스쿼드 배치 가능
        </span>
      </>
    );
  }
  const fresh = results.filter((x) => !x.duplicate && !x.unlocked).length;
  const unlocked = results.filter((x) => x.unlocked).length;
  const refund = results.reduce((s, x) => s + (x.refund || 0), 0);
  const jack = results.some((x) => x.player.enhanced) ? '💎 잭팟 포함! ' : '';
  return (
    <>
      {jack}
      {results.length}장 개봉 완료
      <span className="sub">
        신규 영입 {fresh}명 · 사용권 해금 {unlocked}명 · 중복 환급 🪙{refund.toLocaleString()}
      </span>
    </>
  );
}
