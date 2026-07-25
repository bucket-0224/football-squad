import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import PlayerCard from './PlayerCard';
import { upgradedCard } from '../game/cards';
import type { Complaint } from '../types';

export default function ComplaintDetail({ complaint, onClose }: { complaint: Complaint; onClose: () => void }) {
  const { me, bootstrap, catalog, resolveComplaint } = useAppStore();
  if (!me || !bootstrap) return null;
  const p = catalog.get(complaint.playerId);
  const card = p ? upgradedCard(me, p) : undefined;

  // 요청: "선수가 원하는 포지션이 어떤건지도 알려주는 리포트가 필요해" —
  // 카드 자체의 포지션(p.pos, 선수가 뛰고 싶어하는 자리)과 지금 클럽
  // 스쿼드에 실제로 배치된 슬롯 포지션을 나란히 보여준다. 둘이 다르면
  // "포지션 불일치"로 표시해, 특히 감독 스타일/포메이션 불만(formation
  // 이슈)일 때 왜 이 선수가 불만인지 바로 읽히게 한다.
  const slots = bootstrap.formations[me.squad.formation] || [];
  const slotIdx = me.squad.starters.findIndex((id) => id === complaint.playerId);
  const currentSlotPos = slotIdx >= 0 ? slots[slotIdx] : null;
  const outOfPosition = !!(p && currentSlotPos && currentSlotPos !== p.pos);

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
            {p && (
              <div className="complaint-position-note dim small-text">
                선호 포지션: <b>{p.pos}</b>
                {currentSlotPos && (
                  <>
                    {' '}
                    · 현재 배치: <b className={outOfPosition ? 'complaint-pos-mismatch' : undefined}>{currentSlotPos}</b>
                    {outOfPosition && ' ⚠️ 포지션 불일치'}
                  </>
                )}
              </div>
            )}
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
