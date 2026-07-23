import { useAppStore } from '../store/useAppStore';
import { toast } from '../store/useToastStore';

export default function MailboxModal({ onClose }: { onClose: () => void }) {
  const { me, claimMail } = useAppStore();
  if (!me) return null;

  const mail = [...(me.mailbox || [])].sort((a, b) => b.createdAt - a.createdAt);

  const claim = async (mailId: string) => {
    try {
      await claimMail(mailId);
      toast('우편을 수령했습니다.');
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
    </div>
  );
}
