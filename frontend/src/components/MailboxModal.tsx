import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';
import { PackRevealModal } from './tabs/PacksTab';
import type { PackResult } from '../types';

// 요청: "우편으로 열면 바로 팝업이 떠서 어떤 카드, 혹은 크레딧이 받아지는지
// 확인할 수 있게" — 코인만 든 우편은 이 작은 팝업으로, 팩(카드 개봉권)이
// 든 우편은 기존 PackRevealModal을 그대로 재사용해서 보여준다.
function CoinsRevealModal({ coins, onClose }: { coins: number; onClose: () => void }) {
  return (
    <div
      id="coins-reveal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal coins-reveal-modal">
        <div className="coins-reveal-icon">🪙</div>
        <div className="coins-reveal-amount">{coins.toLocaleString()} 코인</div>
        <p className="dim small-text">우편함에서 코인을 수령했습니다.</p>
        <button type="button" className="btn primary" onClick={onClose}>
          확인
        </button>
      </div>
    </div>
  );
}

export default function MailboxModal({ onClose }: { onClose: () => void }) {
  const { me, claimMail } = useAppStore();
  const [reveal, setReveal] = useState<{ packResults: PackResult[] | null; coins: number } | null>(null);
  if (!me) return null;

  const mail = [...(me.mailbox || [])].sort((a, b) => b.createdAt - a.createdAt);

  const claim = async (mailId: string) => {
    try {
      const { mail: claimed, packResults } = await claimMail(mailId);
      if (packResults && packResults.length) {
        setReveal({ packResults, coins: 0 });
      } else if (claimed.coins) {
        setReveal({ packResults: null, coins: claimed.coins });
      } else {
        toast('우편을 수령했습니다.');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      id="mail-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-modal">
        <div className="picker-head">
          <span>✉️ 우편함</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div id="mail-list">
          {mail.map((m) => (
            <div className={'mail-item' + (m.claimed ? ' claimed' : '')} key={m.id}>
              <div className="mail-body">
                {m.coins ? <div className="mail-coins">🪙 {m.coins.toLocaleString()}</div> : null}
                {m.packs && m.packs.length ? (
                  <div className="mail-coins">
                    🎁 {m.packs.map((p) => `${p.id} x${p.count}`).join(', ')}
                  </div>
                ) : null}
                {m.message ? <div className="mail-msg">{m.message}</div> : null}
                <div className="mail-date">{new Date(m.createdAt).toLocaleString()}</div>
              </div>
              {m.claimed ? (
                <span className="dim small-text">수령완료</span>
              ) : (
                <button type="button" className="btn small primary" onClick={() => claim(m.id)}>
                  수령
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {reveal?.packResults && (
        <PackRevealModal results={reveal.packResults} onClose={() => setReveal(null)} />
      )}
      {reveal && !reveal.packResults && (
        <CoinsRevealModal coins={reveal.coins} onClose={() => setReveal(null)} />
      )}
    </div>
  );
}
