import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import { activeRatings, activeSquad, upgradedCard } from '../../game/cards';
import { COORDS } from '../../game/formationCoords';
import { BAND_LABEL, bandOfY, convertedCardByBand, slotPositionLabel } from '../../game/bands';
import PlayerCard, { EmptySlotCard } from '../PlayerCard';
import OwnedList from '../OwnedList';
import PickerModal from '../PickerModal';
import EnhanceModal from '../EnhanceModal';
import ClubChangeModal from '../ClubChangeModal';
import PlayerDetailModal from '../PlayerDetailModal';
import type { CatalogPlayer, Ratings, Role, Squad } from '../../types';

// 드래그 시작 후 이 거리(px)를 넘게 움직여야 "드래그"로 인정한다 — 그 전까지는
// 일반 클릭(선수 정보 열기 등)과 구분이 안 되므로, pointerdown~pointerup 사이
// 이동량이 이 값 미만이면 클릭으로 취급해 기존 클릭 동작을 그대로 둔다.
const DRAG_THRESHOLD_PX = 8;

// "ⓘ" 유니코드 한 글자는 원과 i가 폰트에 미리 합쳐진 글리시프라 배지의 CSS
// 원 배경과 서로 다른 중심을 갖는다 — 안쪽 여백을 아무리 조정해도 폰트마다
// 미세하게 어긋난다. 원은 버튼 배경(.slot-info)이 그리고, 이 SVG는 순수하게
// 점+세로획만 그려 항상 정확히 중앙에 오게 한다.
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
      <circle cx="12" cy="6.5" r="2.3" fill="currentColor" />
      <rect x="9.8" y="10.5" width="4.4" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

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

interface DragGhost {
  playerId: string;
  card: CatalogPlayer;
  x: number;
  y: number;
}

function clampPct(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// 좌표(y%, 골키퍼 제외) 오름차순 목록을 "라인"으로 묶어 인원수 배열로 만든다
// — 값 사이 간격이 GAP_THRESHOLD(%p)를 넘으면 새 라인 시작. 예:
// [17,17,22,22, 38,38, 58, 64,64, 82] -> [4,2,3,1] (="4-2-3-1").
// COORDS의 프리셋 좌표 자체에 대해 돌려도 그 포메이션의 이름과 정확히 같은
// 배열이 나오도록 실측 좌표 간격에 맞춰 값을 골랐다(5개 포메이션 전부 확인).
const GAP_THRESHOLD = 10;

function clusterLineCounts(ys: number[]): number[] {
  const sorted = [...ys].sort((a, b) => a - b);
  const bands: number[] = [];
  let count = 0;
  let prev: number | null = null;
  for (const y of sorted) {
    if (prev !== null && y - prev > GAP_THRESHOLD) {
      bands.push(count);
      count = 0;
    }
    count++;
    prev = y;
  }
  if (count > 0) bands.push(count);
  return bands;
}

export default function SquadTab() {
  const { me, squadMode, setSquadMode, bootstrap, catalog, saveSquad, autoPlaceSquad } = useAppStore();
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [enhanceId, setEnhanceId] = useState<string | null>(null);
  const [clubChangeOpen, setClubChangeOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  // 배치 편집 모드: on이면 카드를 드래그해도 선수를 스왑하는 대신 그 슬롯
  // 자체의 피치 위 좌표를 옮긴다 — 포메이션이 정해준 자리에 갇히지 않고
  // 언제든 자유롭게 전술 위치를 조정할 수 있게 하기 위함.
  const [posMode, setPosMode] = useState(false);
  const [draftCoord, setDraftCoord] = useState<{ i: number; x: number; y: number } | null>(null);
  const pitchRef = useRef<HTMLDivElement>(null);

  // pointerdown~pointerup 사이의 진행 중 드래그 정보. React state가 아니라
  // ref인 이유: pointermove마다 리렌더할 필요 없이 ghost(state)로만 반영하고,
  // "지금 드래그 중인지"는 클릭 억제 판단(justDraggedRef)에도 즉시 필요해서다.
  const dragRef = useRef<{ playerId: string; card: CatalogPlayer; startX: number; startY: number; moved: boolean } | null>(null);
  const posDragRef = useRef<{ slotIndex: number; startX: number; startY: number; moved: boolean } | null>(null);
  const justDraggedRef = useRef(false);

  if (!me || !bootstrap) return null;

  const squad = activeSquad(me, squadMode);
  const ratings = activeRatings(me, squadMode);
  const slots = bootstrap.formations[squad.formation] || [];
  const baseCoords = COORDS[squad.formation] || COORDS['4-3-3'];
  const coords: [number, number][] =
    squad.slotCoords && squad.slotCoords.length === slots.length
      ? squad.slotCoords.map((c, i) => c || baseCoords[i] || [50, 50])
      : baseCoords;

  // 픽커 모달(PickerModal.assign)과 동일한 배치/스왑 로직 — 대상 슬롯에 이미
  // 있는 다른 슬롯의 선수를 드래그해 놓으면 자동으로 두 자리가 맞바뀐다.
  const assignToSlot = async (playerId: string, targetSlot: number) => {
    const starters = [...squad.starters];
    const existing = starters.indexOf(playerId);
    if (existing === targetSlot) return;
    if (existing >= 0) starters[existing] = starters[targetSlot];
    starters[targetSlot] = playerId;
    try {
      await saveSquad({ starters });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const beginDrag = (playerId: string, card: CatalogPlayer, x: number, y: number) => {
    dragRef.current = { playerId, card, startX: x, startY: y, moved: false };
  };

  const beginPosDrag = (slotIndex: number, x: number, y: number) => {
    posDragRef.current = { slotIndex, startX: x, startY: y, moved: false };
  };

  const pitchPct = (clientX: number, clientY: number) => {
    const rect = pitchRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: clampPct(((clientX - rect.left) / rect.width) * 100, 3, 97),
      y: clampPct(((rect.bottom - clientY) / rect.height) * 100, 2, 92),
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pd = posDragRef.current;
      if (pd) {
        if (!pd.moved) {
          const dist = Math.hypot(e.clientX - pd.startX, e.clientY - pd.startY);
          if (dist < DRAG_THRESHOLD_PX) return;
          pd.moved = true;
        }
        const pct = pitchPct(e.clientX, e.clientY);
        if (pct) setDraftCoord({ i: pd.slotIndex, x: pct.x, y: pct.y });
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (dist < DRAG_THRESHOLD_PX) return;
        d.moved = true;
      }
      setGhost({ playerId: d.playerId, card: d.card, x: e.clientX, y: e.clientY });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const slotEl = el && (el as HTMLElement).closest<HTMLElement>('[data-slot]');
      setDropSlot(slotEl ? Number(slotEl.dataset.slot) : null);
    };
    const onUp = (e: PointerEvent) => {
      const pd = posDragRef.current;
      posDragRef.current = null;
      if (pd && pd.moved) {
        justDraggedRef.current = true;
        const pct = pitchPct(e.clientX, e.clientY);
        if (pct) {
          const next = coords.map((c, idx) => (idx === pd.slotIndex ? [pct.x, pct.y] : c)) as [number, number][];
          saveSquad({ slotCoords: next }).catch((err) => toast(err instanceof Error ? err.message : String(err)));
        }
        setDraftCoord(null);
        return;
      }
      const d = dragRef.current;
      dragRef.current = null;
      if (d && d.moved) {
        justDraggedRef.current = true;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const slotEl = el && (el as HTMLElement).closest<HTMLElement>('[data-slot]');
        if (slotEl) assignToSlot(d.playerId, Number(slotEl.dataset.slot));
      }
      setGhost(null);
      setDropSlot(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squad.starters, coords]);

  const onResetCoords = () => {
    saveSquad({ slotCoords: null }).catch((err) => toast(err instanceof Error ? err.message : String(err)));
  };

  // 배치 편집을 끝낼 때, 자유롭게 옮긴 위치를 라인 단위로 다시 묶어(골키퍼
  // 제외) "4-2-3-1"처럼 실제 구조와 같은 이름의 포메이션을 스피너에 반영한다.
  // 알려진 5개 포메이션 각각의 자체 좌표도 같은 방식으로 묶으면 그 이름과
  // 정확히 같은 배열이 나오므로, 정확히 일치하면 그 이름을, 어디에도 딱
  // 맞지 않는 배치라면 라인 구성이 가장 가까운 포메이션을 대신 고른다.
  const onTogglePosMode = () => {
    if (posMode) {
      const ys = coords.filter((_, i) => slots[i] !== 'GK').map(([, y]) => y);
      const bands = clusterLineCounts(ys);
      let best: string | null = null;
      let bestDist = Infinity;
      for (const name of Object.keys(bootstrap.formations)) {
        const nameCoords = COORDS[name];
        if (!nameCoords) continue;
        const nameBands = clusterLineCounts(nameCoords.slice(1).map(([, y]) => y));
        const len = Math.max(bands.length, nameBands.length);
        let dist = 0;
        for (let k = 0; k < len; k++) dist += Math.abs((bands[k] || 0) - (nameBands[k] || 0));
        if (dist < bestDist || (dist === bestDist && name === squad.formation)) {
          bestDist = dist;
          best = name;
        }
      }
      if (best && best !== squad.formation) {
        saveSquad({ formation: best, slotCoords: coords }).catch((err) =>
          toast(err instanceof Error ? err.message : String(err))
        );
      }
    }
    setPosMode((v) => !v);
  };

  // 드래그 직후 이어지는 합성 click을 삼켜서, 슬롯을 드래그로 옮긴 뒤에
  // 곧바로 픽커 모달이 열리는 걸 막는다.
  const guardClick = (fn: () => void) => () => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    fn();
  };

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
      toast('베스트 XI를 추천했습니다. (배치 위치는 변경되지 않았습니다)');
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
          </div>
          <div className="pitch-actions">
            <button type="button" className="btn small" onClick={onAuto}>
              베스트 XI 추천
            </button>
            <button type="button" className={'btn small' + (posMode ? ' primary' : '')} onClick={onTogglePosMode}>
              {posMode ? '배치 편집 완료' : '🎯 배치 편집'}
            </button>
            {squad.slotCoords && (
              <button type="button" className="btn small ghost" onClick={onResetCoords}>
                위치 초기화
              </button>
            )}
          </div>
          {posMode && (
            <p className="dim small-text pos-edit-hint">
              선수 카드를 드래그하면 그 자리(슬롯)가 피치 위 원하는 위치로 옮겨집니다. 포메이션 틀에 얽매이지 않고 자유롭게 조정하세요. (골키퍼는 이동할 수 없습니다.)
              편집을 마치면 배치에 맞는 포메이션이 자동으로 선택됩니다.
            </p>
          )}
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
          <div id="pitch" ref={pitchRef} className={posMode ? 'pos-editing' : ''}>
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
              const [bx, by] = coords[i] || [50, 50];
              const [x, y] = draftCoord && draftCoord.i === i ? [draftCoord.x, draftCoord.y] : [bx, by];
              const band = pos === 'GK' ? 5 : bandOfY(y);
              return (
                <div
                  key={i}
                  className={
                    'slot' +
                    (ghost ? ' drop-target' : '') +
                    (dropSlot === i ? ' drop-hover' : '') +
                    (posMode && pos !== 'GK' ? ' pos-editable' : '') +
                    (posMode && pos === 'GK' ? ' pos-locked' : '') +
                    (draftCoord && draftCoord.i === i ? ' pos-dragging' : '')
                  }
                  data-slot={i}
                  style={{ left: x + '%', bottom: y + '%' }}
                >
                  <button
                    type="button"
                    className="slot-assign"
                    onClick={guardClick(() => setPickerSlot(i))}
                    onPointerDown={(e) => {
                      // 골키퍼는 항상 골문 근처에 고정 — 배치 편집 모드에서도 옮길 수 없다.
                      if (posMode && pos !== 'GK') beginPosDrag(i, e.clientX, e.clientY);
                      else if (!posMode && p) beginDrag(p.id, p, e.clientX, e.clientY);
                    }}
                  >
                    {p ? (
                      <PlayerCard player={convertedCardByBand(p, x, y)} size="xs" badge={badge} />
                    ) : (
                      <EmptySlotCard pos={pos === 'GK' ? 'GK' : slotPositionLabel(x, y)} />
                    )}
                  </button>
                  {posMode && <span className="slot-band-tag">{BAND_LABEL[band]}</span>}
                  {p && (
                    <button
                      type="button"
                      className="slot-info"
                      title="선수 정보"
                      onClick={guardClick(() => setDetailId(p.id))}
                    >
                      <InfoIcon />
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
        <PickerModal
          slotIndex={pickerSlot}
          pos={slots[pickerSlot]}
          band={slots[pickerSlot] === 'GK' ? 5 : bandOfY((coords[pickerSlot] || [50, 50])[1])}
          onClose={() => setPickerSlot(null)}
        />
      )}
      {enhanceId && <EnhanceModal playerId={enhanceId} onClose={() => setEnhanceId(null)} />}
      {clubChangeOpen && <ClubChangeModal onClose={() => setClubChangeOpen(false)} />}
      {detailId && <PlayerDetailModal playerId={detailId} onClose={() => setDetailId(null)} />}
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <PlayerCard player={ghost.card} size="xs" />
        </div>
      )}
    </div>
  );
}
