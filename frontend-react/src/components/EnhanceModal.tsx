import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { upLevel, upgradedCard } from '../game/cards';
import PlayerCard from './PlayerCard';

interface LogLine {
  text: string;
  cls: 'good' | 'bad';
}

export default function EnhanceModal({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const { me, bootstrap, catalog, enhancePlayer } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [flashCls, setFlashCls] = useState('');
  const [flashToken, setFlashToken] = useState(0);

  if (!me || !bootstrap) return null;
  const base = catalog.get(playerId);
  if (!base) return null;

  const lvl = upLevel(me, playerId);
  const cfg = bootstrap.enhance;
  const cur = upgradedCard(me, base)!;
  const maxed = lvl >= cfg.maxLevel;
  const next = lvl + 1;
  const cost = Math.max(50, Math.round((base.price || 200) * cfg.costRate * next));
  const rate = Math.round((cfg.rates[next - 1] || 0) * 100);
  const short = me.coins < cost;

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
              <div id="enh-next">
                <span className="dim">✨ 최대 강화 단계에 도달했습니다.</span>
              </div>
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
            <button type="button" className="btn primary" disabled={maxed || short || busy} onClick={onTry}>
              {maxed
                ? '강화 완료'
                : short
                  ? `코인 부족 (🪙 ${cost.toLocaleString()} 필요)`
                  : `⚡ 강화 시도 (🪙 ${cost.toLocaleString()})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
