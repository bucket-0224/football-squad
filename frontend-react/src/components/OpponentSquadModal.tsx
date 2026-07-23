import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { COORDS } from '../game/formationCoords';
import PlayerCard, { EmptySlotCard } from './PlayerCard';
import type { OpponentSquadView, User } from '../types';

export default function OpponentSquadModal({ username, onClose }: { username: string; onClose: () => void }) {
  const { bootstrap, squadMode, saveSquad, autoPlaceSquad, catalog } = useAppStore();
  const [view, setView] = useState<OpponentSquadView | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<OpponentSquadView>(`/api/user/${encodeURIComponent(username)}/squad`)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        toast(err instanceof Error ? err.message : String(err));
        onClose();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  if (!view || !bootstrap) return null;

  const slotPos = bootstrap.formations[view.formation] || [];
  const coords = COORDS[view.formation] || COORDS['4-3-3'];

  const copyStrategy = async () => {
    try {
      // 1) switch to their formation/tactic, keeping my current starters by
      // index where possible
      const slots = bootstrap.formations[view.formation].length;
      const curStarters = useAppStore.getState().me!.squad.starters.slice(0, slots);
      while (curStarters.length < slots) curStarters.push(null);
      await saveSquad({ formation: view.formation, starters: curStarters, tactic: view.tactic });
      // 2) auto-fill the best XI from MY OWN roster in that formation
      await autoPlaceSquad();
      // 3) re-apply their per-slot player "type" (role) onto whoever now sits
      // in that slot on my side, skipping roles that don't fit my player's pos
      const user = useAppStore.getState().me as User;
      const mySquad = squadMode === 'pvp' ? user.pvpSquad : user.squad;
      const roleBySlot = view.starters.map((pid) => (pid ? view.roles[pid] : null));
      const myRoles: Record<string, string> = {};
      mySquad.starters.forEach((pid, i) => {
        if (!pid || !roleBySlot[i]) return;
        const p = catalog.get(pid);
        const role = bootstrap.roles[roleBySlot[i] as string];
        if (p && role && role.pos.includes(p.pos)) myRoles[pid] = roleBySlot[i] as string;
      });
      await saveSquad({ roles: myRoles });
      onClose();
      toast('전략을 복사했습니다! (포메이션·전술·유형 — 보유 선수로 자동 배치)');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="oppo-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span id="oppo-title">
            🔍 {view.clubName} ({view.username}) 스쿼드
          </span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div id="oppo-info" className="dim small-text">
          {view.formation} · 전술: {bootstrap.tactics[view.tactic] || view.tactic} · OVR {view.ratings.OVR}
        </div>
        <div id="oppo-pitch">
          <div className="pitch-lines">
            <div className="center-circle" />
            <div className="halfway" />
            <div className="box box-bottom" />
            <div className="box box-top" />
          </div>
          {view.starterDetails.map((p, i) => {
            const [x, y] = coords[i] || [50, 50];
            const pid = view.starters[i];
            const roleId = pid ? view.roles[pid] : null;
            const roleLabel = roleId && bootstrap.roles[roleId] ? bootstrap.roles[roleId].label : '';
            const badge = pid && pid === view.captain ? 'C' : pid && pid === view.viceCaptain ? 'VC' : undefined;
            return (
              <div key={i} className="slot" style={{ left: x + '%', bottom: y + '%' }} title={p ? (roleLabel ? `${p.name} · ${roleLabel}` : p.name) : undefined}>
                {p ? <PlayerCard player={p} size="xs" badge={badge} /> : <EmptySlotCard pos={slotPos[i] || ''} />}
              </div>
            );
          })}
        </div>
        <button type="button" className="btn primary small" onClick={copyStrategy}>
          📋 이 전략 복사 (포메이션·전술·유형)
        </button>
      </div>
    </div>
  );
}
