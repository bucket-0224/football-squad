import type { Team } from '../types';

export default function TeamCard({
  team,
  selected,
  extraTag,
  onClick,
}: {
  team: Team;
  selected: boolean;
  extraTag?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={'team-card' + (selected ? ' selected' : '')} onClick={onClick}>
      <span className="t-name">
        {team.logo ? (
          <img
            src={team.logo}
            alt=""
            style={{ width: 18, height: 18, objectFit: 'contain' }}
            onError={(e) => e.currentTarget.remove()}
          />
        ) : (
          <span className="team-dot" style={{ background: team.color || '#3b82f6' }} />
        )}
        <span className="t-name-text">{team.name}</span>
      </span>
      <span className="t-meta">
        {team.ovr != null
          ? `${team.type === 'club' ? '클럽' : '국가대표'} · OVR ${team.ovr}`
          : '클럽 · 실제 스쿼드'}
      </span>
      {extraTag ? <span className="starter-tag">{extraTag}</span> : null}
    </button>
  );
}
