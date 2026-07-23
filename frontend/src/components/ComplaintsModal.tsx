import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import PlayerCard from './PlayerCard';
import { upgradedCard } from '../game/cards';
import type { Complaint } from '../types';

function ComplaintDetail({ complaint, onClose }: { complaint: Complaint; onClose: () => void }) {
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

export default function ComplaintsModal({ onClose }: { onClose: () => void }) {
  const { me, catalog } = useAppStore();
  const [active, setActive] = useState<Complaint | null>(null);
  if (!me) return null;

  const complaints = [...(me.complaints || [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div
      id="complaints-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span>😠 선수 불만</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div id="complaints-list">
          {!complaints.length ? (
            <p className="dim">쌓인 불만이 없습니다.</p>
          ) : (
            complaints.map((c) => {
              const p = catalog.get(c.playerId);
              return (
                <div className="mail-item" key={c.id}>
                  <div className="mail-body">
                    <div className="mail-msg">
                      {p ? p.name + ' — ' : ''}
                      {c.prompt}
                    </div>
                    <div className="mail-date">{new Date(c.createdAt).toLocaleString()}</div>
                  </div>
                  <button type="button" className="btn small primary" onClick={() => setActive(c)}>
                    면담
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
      {active && <ComplaintDetail complaint={active} onClose={() => setActive(null)} />}
    </div>
  );
}
