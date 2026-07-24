import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import ComplaintDetail from './ComplaintDetail';
import type { Complaint } from '../types';

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
