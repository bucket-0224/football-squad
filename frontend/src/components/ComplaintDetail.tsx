import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import PlayerCard from './PlayerCard';
import { upgradedCard } from '../game/cards';
import type { Complaint } from '../types';

export default function ComplaintDetail({ complaint, onClose }: { complaint: Complaint; onClose: () => void }) {
  const { me, catalog, resolveComplaint } = useAppStore();
  if (!me) return null;
  const p = catalog.get(complaint.playerId);
  const card = p ? upgradedCard(me, p) : undefined;

  const choose = async (choiceId: string) => {
    try {
      const r = await resolveComplaint(complaint.id, choiceId);
      toast(r.satisfied ? '선수가 만족했습니다. 헌신도가 상승했습니다.' : '선수의 반응이 미온적입니다.');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="complaint-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal">
        <div className="picker-head">
          <span>😠 선수 면담</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="nego-body">
          <div id="complaint-card-col">{card && <PlayerCard player={card} size="md" stats />}</div>
          <div className="nego-main">
            <div id="complaint-prompt">
              {p ? p.name + ' — ' : ''}
              {complaint.prompt}
            </div>
            <div id="complaint-choices">
              {complaint.choices.map((c) => (
                <button key={c.id} type="button" className="btn" onClick={() => choose(c.id)}>
                  {c.label}
                  {c.costCoins ? ` (🪙${c.costCoins})` : ''}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
