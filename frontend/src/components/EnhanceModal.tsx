import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { isUltra, upLevel, upgradedCard } from '../game/cards';
import PlayerCard from './PlayerCard';

interface LogLine {
  text: string;
  cls: 'good' | 'bad';
}

export default function EnhanceModal({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const { me, bootstrap, catalog, enhancePlayer, evolvePlayer } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [flashCls, setFlashCls] = useState('');
  const [flashToken, setFlashToken] = useState(0);

  if (!me || !bootstrap) return null;
  const base = catalog.get(playerId);
  if (!base) return null;

  const lvl = upLevel(me, playerId);
  const cfg = bootstrap.enhance;
  const evolved = isUltra(me, playerId);
  const cur = upgradedCard(me, base)!;
  const maxed = lvl >= cfg.maxLevel;
  const next = lvl + 1;
  const cost = Math.max(50, Math.round((base.price || 200) * cfg.costRate * next));
  const rate = Math.round((cfg.rates[next - 1] || 0) * 100);
  const short = me.coins < cost;
  const ultraCost = bootstrap.ultra.cost;
  const ultraShort = me.coins < ultraCost;

  const onTry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await enhancePlayer(playerId);
      setFlashCls(r.success ? 'enh-flash' : 'enh-shake');
      setFlashToken((t) => t + 1);
      setLog((l) => [
        ...l,
        r.success
          ? { text: `✨ 강화 성공! +${r.level} 단계 (−🪙${r.cost.toLocaleString()})`, cls: 'good' }
          : { text: `💥 강화 실패… 단계는 유지됩니다 (−🪙${r.cost.toLocaleString()})`, cls: 'bad' },
      ]);
    } catch (err) {
      setLog((l) => [...l, { text: err instanceof Error ? err.message : String(err), cls: 'bad' }]);
    } finally {
      setBusy(false);
    }
  };

  // 요청: "강화가 5강까지 끝나면 Ultra로 등급 진화 3000크레딧을 소모해서
  // 되게 해주고" — 확률이 있는 강화와 달리 코인만 내면 항상 성공한다.
  const onEvolve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await evolvePlayer(playerId);
      setFlashCls('enh-flash');
      setFlashToken((t) => t + 1);
      setLog((l) => [...l, { text: `🌟 Ultra 진화 완료! (−🪙${ultraCost.toLocaleString()})`, cls: 'good' }]);
    } catch (err) {
      setLog((l) => [...l, { text: err instanceof Error ? err.message : String(err), cls: 'bad' }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id="enh-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal enh-modal">
        <div className="picker-head">
          <span>
            ⚡ 선수 강화{' '}
            <span className="mode-hint">단계당 OVR·능력치 +1 · 실패해도 단계는 유지</span>
          </span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="nego-body">
          <div id="enh-card" key={flashToken} className={flashCls}>
            <PlayerCard player={cur} size="md" stats />
          </div>
          <div className="nego-main">
            <div id="enh-level">
              강화 단계{' '}
              <span className="enh-stars">
                {'★'.repeat(lvl)}
                {'☆'.repeat(Math.max(0, cfg.maxLevel - lvl))}
              </span>{' '}
              <b>+{lvl}</b>
            </div>
            {maxed ? (
              evolved ? (
                <div id="enh-next">
                  <span className="dim">🌟 Ultra 등급 진화까지 완료했습니다.</span>
                </div>
              ) : (
                <div id="enh-next" className="small-text">
                  🌟 Ultra로 진화하면 OVR·능력치가 추가로 <b>+{bootstrap.ultra.bonus}</b> 오릅니다 (
                  <b>OVR {cur.ovr} → {Math.min(99, cur.ovr + bootstrap.ultra.bonus)}</b>). 확률 없이 코인만 내면
                  확정 성공하며, 진화 후에는 이적시장에서 실적가 + 🪙2,000으로 판매할 수 있습니다.
                </div>
              )
            ) : (
              <div id="enh-next" className="small-text">
                +{next} 강화 시 OVR <b>{cur.ovr}</b> → <b>{Math.min(99, base.ovr + next)}</b> · 성공 확률{' '}
                <b>{rate}%</b> · 실패 시 코인만 소모
              </div>
            )}
            <div id="enh-log">
              {log.map((l, i) => (
                <div key={i} className={'nego-line ' + l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
            {maxed && !evolved ? (
              <button type="button" className="btn primary" disabled={ultraShort || busy} onClick={onEvolve}>
                {ultraShort
                  ? `코인 부족 (🪙 ${ultraCost.toLocaleString()} 필요)`
                  : `🌟 Ultra 진화 (🪙 ${ultraCost.toLocaleString()})`}
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={maxed || short || busy} onClick={onTry}>
                {maxed
                  ? '🌟 Ultra 진화 완료'
                  : short
                    ? `코인 부족 (🪙 ${cost.toLocaleString()} 필요)`
                    : `⚡ 강화 시도 (🪙 ${cost.toLocaleString()})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
