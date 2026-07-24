import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { activePoolIds, activeSquad, slotLineOf, upgradedCard } from '../game/cards';
import { bandPenalty, fitByBand, type Band } from '../game/bands';
import PlayerCard from './PlayerCard';
import type { CatalogPlayer } from '../types';

interface PickerModalProps {
  slotIndex: number;
  pos: string;
  band: Band;
  onClose: () => void;
}

export default function PickerModal({ slotIndex, pos, band, onClose }: PickerModalProps) {
  const { me, squadMode, catalog, saveSquad } = useAppStore();
  if (!me) return null;

  const squad = activeSquad(me, squadMode);
  const line = slotLineOf(pos);
  const currentId = squad.starters[slotIndex];
  const owned = activePoolIds(me, squadMode)
    .map((id) => upgradedCard(me, catalog.get(id)))
    .filter((p): p is CatalogPlayer => !!p)
    .filter((p) => (line === 'GK' ? p.line === 'GK' : p.line !== 'GK'))
    .filter((p) => p.id !== currentId)
    .sort((a, b) => {
      const fa = a.line === line ? 2 : 0;
      const fb = b.line === line ? 2 : 0;
      return fb - fa || b.ovr - a.ovr;
    });

  const assign = async (playerId: string) => {
    const starters = [...squad.starters];
    const existing = starters.indexOf(playerId);
    if (existing >= 0) starters[existing] = starters[slotIndex]; // swap
    starters[slotIndex] = playerId;
    try {
      await saveSquad({ starters });
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const clearSlot = async () => {
    const starters = [...squad.starters];
    starters[slotIndex] = null;
    try {
      await saveSquad({ starters });
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="picker-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span id="picker-title">{pos} 슬롯에 배치할 선수 선택</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            ✕
          </button>
        </div>
        <button type="button" className="btn ghost small" onClick={clearSlot}>
          슬롯 비우기
        </button>
        <div id="picker-list">
          {!owned.length && (
            <p className="dim">{line === 'GK' ? '배치 가능한 골키퍼가 없습니다.' : '배치 가능한 선수가 없습니다.'}</p>
          )}
          {owned.map((p) => {
            const [cls, label] = fitByBand(p.pos, band);
            const pen = bandPenalty(p.pos, band);
            const inSlot = squad.starters.indexOf(p.id);
            const shown = pen ? { ...p, ovr: Math.max(30, p.ovr - pen) } : p;
            return (
              <div key={p.id} className="card-cell picker-cell" onClick={() => assign(p.id)}>
                <PlayerCard player={shown} size="sm" flag={inSlot >= 0 ? '선발중' : undefined} />
                <div className="cc-fit">
                  <span className={`fit-tag ${cls}`}>
                    {label}
                    {pen ? ` −${pen}` : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
