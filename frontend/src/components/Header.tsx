import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import MailboxModal from './MailboxModal';
import NotificationsModal from './NotificationsModal';

export default function Header() {
  const { me, logout } = useAppStore();
  const [mailOpen, setMailOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  if (!me) return null;

  const unclaimed = (me.mailbox || []).filter((m) => !m.claimed).length;
  const pendingNotifs = (me.complaints || []).length + (me.transferRequests || []).length;

  return (
    <header id="topbar">
      <div className="club-info">
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
        <button type="button" className="btn ghost small" onClick={logout}>
          로그아웃
        </button>
      </div>
      {mailOpen && <MailboxModal onClose={() => setMailOpen(false)} />}
      {notifOpen && <NotificationsModal onClose={() => setNotifOpen(false)} />}
    </header>
  );
}
