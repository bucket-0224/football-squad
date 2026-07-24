import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import PlayerCard from './PlayerCard';
import ComplaintDetail from './ComplaintDetail';
import { upgradedCard } from '../game/cards';

export default function PlayerDetailModal({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const { me, catalog } = useAppStore();
  const [complaintOpen, setComplaintOpen] = useState(false);
  if (!me) return null;
  const p = catalog.get(playerId);
  const card = p ? upgradedCard(me, p) : undefined;
  if (!card) return null;

  const devotion = me.devotion[playerId] ?? 60;
  const complaint = me.complaints.find((c) => c.playerId === playerId) || null;

  return (
    <div
      id="player-detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal">
        <div className="picker-head">
          <span>👤 선수 정보</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="nego-body player-detail-nego-body">
          <div id="detail-card-col">
            <PlayerCard player={card} size="sm" />
          </div>
          <div className="nego-main">
            {card.attrs && (
              <div className="detail-attrs">
                <div>
                  <span className="dim">스피드</span> <b>{card.attrs.pace}</b>
                </div>
                <div>
                  <span className="dim">슈팅</span> <b>{card.attrs.shooting}</b>
                </div>
                <div>
                  <span className="dim">패스</span> <b>{card.attrs.passing}</b>
                </div>
                <div>
                  <span className="dim">드리블</span> <b>{card.attrs.dribbling}</b>
                </div>
                <div>
                  <span className="dim">수비</span> <b>{card.attrs.defending}</b>
                </div>
                <div>
                  <span className="dim">피지컬</span> <b>{card.attrs.physical}</b>
                </div>
              </div>
            )}
            <div className="detail-physical">
              <span>📏 신장 {card.height ? `${card.height}cm` : '정보 없음'}</span>
              <span>⚖️ 체중 {card.weight ? `${card.weight}kg` : '정보 없음'}</span>
              {card.leadership ? <span className="detail-leader">🎖️ 리더십</span> : null}
            </div>
            <div className="detail-devotion">
              <span className="dim small-text">헌신도</span>
              <div className="devotion-bar">
                <div className="devotion-fill" style={{ width: `${devotion}%` }} />
              </div>
              <span>{devotion}/100</span>
            </div>
            {complaint ? (
              <div className="detail-complaint">
                <p>😠 {complaint.prompt}</p>
                <button type="button" className="btn small primary" onClick={() => setComplaintOpen(true)}>
                  면담하기
                </button>
              </div>
            ) : (
              <p className="dim small-text">현재 쌓인 불만이 없습니다.</p>
            )}
          </div>
        </div>
      </div>
      {complaintOpen && complaint && (
        <ComplaintDetail
          complaint={complaint}
          onClose={() => {
            setComplaintOpen(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}
