import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import ComplaintDetail from './ComplaintDetail';
import TransferRequestDetail from './TransferRequestDetail';
import type { Complaint, TransferRequest } from '../types';

type NotifItem =
  | { kind: 'complaint'; id: string; createdAt: number; data: Complaint }
  | { kind: 'transfer'; id: string; createdAt: number; data: TransferRequest };

export default function NotificationsModal({ onClose }: { onClose: () => void }) {
  const { me, catalog } = useAppStore();
  const [active, setActive] = useState<NotifItem | null>(null);
  if (!me) return null;

  const items: NotifItem[] = [
    ...(me.complaints || []).map((c): NotifItem => ({ kind: 'complaint', id: c.id, createdAt: c.createdAt, data: c })),
    ...(me.transferRequests || []).map(
      (r): NotifItem => ({ kind: 'transfer', id: r.id, createdAt: r.createdAt, data: r })
    ),
  ].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div
      id="notifications-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span>🔔 알림</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div id="notifications-list">
          {!items.length ? (
            <p className="dim">새로운 알림이 없습니다.</p>
          ) : (
            items.map((item) => {
              const p = catalog.get(item.kind === 'complaint' ? item.data.playerId : item.data.playerId);
              const icon = item.kind === 'complaint' ? '😠' : '✈️';
              const label = item.kind === 'complaint' ? '선수 불만' : '이적 요청';
              return (
                <div className="mail-item" key={`${item.kind}-${item.id}`}>
                  <div className="mail-body">
                    <div className="mail-msg">
                      {icon} {p ? p.name : '선수'} — {label}
                    </div>
                    <div className="mail-date">{new Date(item.createdAt).toLocaleString()}</div>
                  </div>
                  <button type="button" className="btn small primary" onClick={() => setActive(item)}>
                    확인
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
      {active && active.kind === 'complaint' && (
        <ComplaintDetail complaint={active.data} onClose={() => setActive(null)} />
      )}
      {active && active.kind === 'transfer' && (
        <TransferRequestDetail request={active.data} onClose={() => setActive(null)} />
      )}
    </div>
  );
}
