import MatchAnalysis from './MatchAnalysis';
import type { MatchRecord } from '../types';

export default function NewsDetailModal({ match, onClose }: { match: MatchRecord; onClose: () => void }) {
  return (
    <div
      id="news-detail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal news-detail-modal">
        <div className="picker-head">
          <span>📊 경기 분석</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="news-detail-score">
          {match.homeName} <b>{match.score.home} - {match.score.away}</b> {match.awayName}
        </div>
        <MatchAnalysis match={match} />
      </div>
    </div>
  );
}
