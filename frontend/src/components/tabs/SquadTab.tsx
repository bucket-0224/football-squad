import { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { activeRatings, activeSquad, convertedCard, upgradedCard } from '../../game/cards';
import { COORDS } from '../../game/formationCoords';
import PlayerCard, { EmptySlotCard } from '../PlayerCard';
import OwnedList from '../OwnedList';
import PickerModal from '../PickerModal';
import EnhanceModal from '../EnhanceModal';
import ClubChangeModal from '../ClubChangeModal';
import PlayerDetailModal from '../PlayerDetailModal';
import type { CatalogPlayer, Ratings, Role, Squad } from '../../types';

function RatingsBar({ ratings }: { ratings: Ratings }) {
  const cells: [string, string | number, string?][] = [
    ['공격', ratings.ATT],
    ['미드필드', ratings.MID],
    ['수비', ratings.DEF],
    ['GK', ratings.GK],
    ['케미', ratings.chemistry + '%'],
    ['OVR', ratings.OVR, 'ovr'],
  ];
  return (
    <div id="ratings-bar">
      {cells.map(([label, value, cls]) => (
        <div key={label} className={`rating-cell ${cls || ''}`}>
          <div className="rc-label">{label}</div>
          <div className="rc-value">{value}</div>
        </div>
      ))}
    </div>
  );
}

function RolePicker({
  squad,
  catalog,
  roles,
}: {
  squad: Squad;
  catalog: Map<string, CatalogPlayer>;
  roles: Record<string, Role>;
}) {
  const saveSquad = useAppStore((s) => s.saveSquad);

  const rows = squad.starters
    .map((id) => (id ? catalog.get(id) : null))
    .filter((p): p is CatalogPlayer => !!p)
    .map((p) => {
      const opts = Object.entries(roles).filter(([, r]) => r.pos.includes(p.pos));
      if (opts.length < 2) return null;
      let current = squad.roles?.[p.id];
      if (!current) {
        const def = opts.find(([, r]) => r.isDefault);
        current = def ? def[0] : opts[0][0];
      }
      return { p, opts, current };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  if (!rows.length) {
    return (
      <div id="role-picker" className="role-picker">
        <p className="dim small-text">선택 가능한 유형이 있는 선발 선수가 없습니다.</p>
      </div>
    );
  }

  const pickRole = (playerId: string, roleId: string) => {
    saveSquad({ roles: { ...(squad.roles || {}), [playerId]: roleId } }).catch((err) =>
      toast(err instanceof Error ? err.message : String(err))
    );
  };

  return (
    <div id="role-picker" className="role-picker">
      {rows.map(({ p, opts, current }) => (
        <div className="role-row" key={p.id}>
          <span className="role-player">
            {p.name} <span className="dim small-text">{p.pos}</span>
          </span>
          <div className="role-chips">
            {opts.map(([roleId, r]) => (
              <button
                key={roleId}
                type="button"
                className={'role-chip' + (roleId === current ? ' active' : '')}
                onClick={() => pickRole(p.id, roleId)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function captainOptions(squad: Squad, catalog: Map<string, CatalogPlayer>, exclude: string | null) {
  return squad.starters
    .filter(Boolean)
    .filter((id) => id !== exclude)
    .map((id) => catalog.get(id as string))
    .filter((p): p is CatalogPlayer => !!p);
}

export default function SquadTab() {
  const { me, squadMode, setSquadMode, bootstrap, catalog, saveSquad, autoPlaceSquad } = useAppStore();
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [enhanceId, setEnhanceId] = useState<string | null>(null);
  const [clubChangeOpen, setClubChangeOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  if (!me || !bootstrap) return null;

  const squad = activeSquad(me, squadMode);
  const ratings = activeRatings(me, squadMode);
  const slots = bootstrap.formations[squad.formation] || [];
  const coords = COORDS[squad.formation] || COORDS['4-3-3'];

  const onFormationChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const formation = e.target.value;
    const slotCount = bootstrap.formations[formation].length;
    const starters = squad.starters.slice(0, slotCount);
    while (starters.length < slotCount) starters.push(null);
    try {
      await saveSquad({ formation, starters });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const onTacticChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const tactic = e.target.value;
    try {
      await saveSquad({ tactic });
      toast('전술이 변경되었습니다: ' + bootstrap.tactics[tactic]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const onAuto = async () => {
    try {
      await autoPlaceSquad();
      toast('베스트 11이 자동 배치되었습니다.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const onCaptainChange = (e: React.ChangeEvent<HTMLSelectElement>) =>
    saveSquad({ captain: e.target.value || null }).catch((err) =>
      toast(err instanceof Error ? err.message : String(err))
    );
  const onViceChange = (e: React.ChangeEvent<HTMLSelectElement>) =>
    saveSquad({ viceCaptain: e.target.value || null }).catch((err) =>
      toast(err instanceof Error ? err.message : String(err))
    );

  return (
    <div id="tab-squad" className="tab-panel">
      <div id="squad-mode">
        <button
          type="button"
          className={squadMode === 'main' ? 'active' : ''}
          onClick={() => setSquadMode('main')}
        >
          클럽 스쿼드
        </button>
        <button
          type="button"
          className={squadMode === 'pvp' ? 'active' : ''}
          onClick={() => setSquadMode('pvp')}
        >
          실전 스쿼드 <span className="mode-hint">뽑은 카드 전용</span>
        </button>
        <button type="button" className="club-change-btn" onClick={() => setClubChangeOpen(true)}>
          🔄 클럽 변경 <span className="mode-hint">승점 {bootstrap.clubChangeCost}</span>
        </button>
      </div>
      {squadMode === 'pvp' && (
        <p id="pvp-note" className="dim small-text">
          랭크 매치는 <b>실전 스쿼드</b>(뽑기로 획득한 카드)로 진행됩니다. 빈 슬롯은 최소 능력치 선수로 채워집니다.
        </p>
      )}
      <div className="squad-layout">
        <div className="pitch-col">
          <div className="pitch-toolbar">
            <select id="formation-select" value={squad.formation} onChange={onFormationChange}>
              {Object.keys(bootstrap.formations).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              id="tactic-select"
              title="전술"
              value={squad.tactic || 'balanced'}
              onChange={onTacticChange}
            >
              {Object.entries(bootstrap.tactics).map(([id, label]) => (
                <option key={id} value={id}>
                  전술: {label}
                </option>
              ))}
            </select>
            <button type="button" className="btn small" onClick={onAuto}>
              자동배치
            </button>
          </div>
          <div className="pitch-toolbar captain-toolbar">
            <span className="dim small-text">주장</span>
            <select id="captain-select" value={squad.captain || ''} onChange={onCaptainChange}>
              <option value="">지정 안 함</option>
              {captainOptions(squad, catalog, squad.viceCaptain).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="dim small-text">부주장</span>
            <select id="vice-select" value={squad.viceCaptain || ''} onChange={onViceChange}>
              <option value="">지정 안 함</option>
              {captainOptions(squad, catalog, squad.captain).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div id="pitch">
            <div className="pitch-lines">
              <div className="center-circle" />
              <div className="halfway" />
              <div className="box box-bottom" />
              <div className="box box-top" />
            </div>
            {slots.map((pos, i) => {
              const id = squad.starters[i];
              const p = id ? upgradedCard(me, catalog.get(id)) : null;
              const badge = id && id === squad.captain ? 'C' : id && id === squad.viceCaptain ? 'VC' : undefined;
              const [x, y] = coords[i] || [50, 50];
              return (
                <div key={i} className="slot" style={{ left: x + '%', bottom: y + '%' }}>
                  <button type="button" className="slot-assign" onClick={() => setPickerSlot(i)}>
                    {p ? <PlayerCard player={convertedCard(p, pos)} size="xs" badge={badge} /> : <EmptySlotCard pos={pos} />}
                  </button>
                  {p && (
                    <button
                      type="button"
                      className="slot-info"
                      title="선수 정보"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailId(p.id);
                      }}
                    >
                      ⓘ
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <RatingsBar ratings={ratings} />
          <RolePicker squad={squad} catalog={catalog} roles={bootstrap.roles} />
        </div>
        <OwnedList onEnhance={setEnhanceId} onDetail={setDetailId} />
      </div>
      {pickerSlot !== null && (
        <PickerModal slotIndex={pickerSlot} pos={slots[pickerSlot]} onClose={() => setPickerSlot(null)} />
      )}
      {enhanceId && <EnhanceModal playerId={enhanceId} onClose={() => setEnhanceId(null)} />}
      {clubChangeOpen && <ClubChangeModal onClose={() => setClubChangeOpen(false)} />}
      {detailId && <PlayerDetailModal playerId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
