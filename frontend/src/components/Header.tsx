import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { avatarSrc } from '../config';
import MailboxModal from './MailboxModal';
import NotificationsModal from './NotificationsModal';
import AccountSettingsModal from './AccountSettingsModal';

export default function Header() {
  const { me, logout } = useAppStore();
  const [mailOpen, setMailOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const src = me ? avatarSrc(me.avatarUrl) : null;
  // src가 바뀌면(새로 업로드 등) 이전에 깨졌었다는 상태를 지워서 새 이미지를
  // 다시 시도할 기회를 준다 — 안 그러면 한 번 깨진 뒤로는 계속 이니셜만 보임.
  useEffect(() => {
    setAvatarBroken(false);
  }, [src]);
  if (!me) return null;

  const unclaimed = (me.mailbox || []).filter((m) => !m.claimed).length;
  const pendingNotifs = (me.complaints || []).length + (me.transferRequests || []).length;

  return (
    <header id="topbar">
      <div className="club-info">
        {src && !avatarBroken ? (
          <img className="hdr-avatar" src={src} alt="" onError={() => setAvatarBroken(true)} />
        ) : (
          <span className="hdr-avatar hdr-avatar-placeholder">{me.username.slice(0, 1).toUpperCase()}</span>
        )}
        <span className="club-name">{me.clubName}</span>
        <span className="chip ovr-chip">OVR {me.ratings.OVR}</span>
      </div>
      <div className="hdr-right">
        <span className="chip coin-chip">🪙 {me.coins.toLocaleString()}</span>
        <span className="chip point-chip">🏆 승점 {me.points}</span>
        <button type="button" className="btn ghost small mailbox-btn" onClick={() => setMailOpen(true)}>
          ✉️ <span className={'mailbox-badge' + (unclaimed ? '' : ' hidden')}>{unclaimed}</span>
        </button>
        <button type="button" className="btn ghost small mailbox-btn" onClick={() => setNotifOpen(true)}>
          🔔 <span className={'mailbox-badge' + (pendingNotifs ? '' : ' hidden')}>{pendingNotifs}</span>
        </button>
        <button type="button" className="btn ghost small" onClick={() => setSettingsOpen(true)} title="계정 설정">
          ⚙️
        </button>
        <button type="button" className="btn ghost small" onClick={logout}>
          로그아웃
        </button>
      </div>
      {mailOpen && <MailboxModal onClose={() => setMailOpen(false)} />}
      {notifOpen && <NotificationsModal onClose={() => setNotifOpen(false)} />}
      {settingsOpen && <AccountSettingsModal onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
