import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import PlayerCard from './PlayerCard';
import { upgradedCard } from '../game/cards';
import type { TransferRequest } from '../types';

export default function TransferRequestDetail({ request, onClose }: { request: TransferRequest; onClose: () => void }) {
  const { me, catalog, resolveTransferRequest } = useAppStore();
  if (!me) return null;
  const p = catalog.get(request.playerId);
  const card = p ? upgradedCard(me, p) : undefined;

  const choose = async (choice: 'keep' | 'release') => {
    try {
      const r = await resolveTransferRequest(request.id, choice);
      toast(r.released ? `${p ? p.name + ' 선수가' : '선수가'} 팀을 떠났습니다.` : '선수를 잔류시켰습니다. 헌신도가 회복되었습니다.');
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="transfer-request-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal">
        <div className="picker-head">
          <span>✈️ 이적 요청</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="nego-body">
          <div id="transfer-request-card-col">{card && <PlayerCard player={card} size="md" stats />}</div>
          <div className="nego-main">
            <div id="transfer-request-prompt">
              {p ? p.name + ' — ' : ''}
              더 이상 이 팀에서 뛰고 싶지 않다며 이적을 요청합니다.
            </div>
            <div id="transfer-request-choices">
              <button type="button" className="btn primary" onClick={() => choose('keep')}>
                잔류시키기
              </button>
              <button type="button" className="btn" onClick={() => choose('release')}>
                이적 허용 (보상 없음)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
