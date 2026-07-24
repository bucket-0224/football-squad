import { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import MailboxModal from './MailboxModal';
import ComplaintsModal from './ComplaintsModal';
import TransferRequestModal from './TransferRequestModal';

export default function Header() {
  const { me, logout } = useAppStore();
  const [mailOpen, setMailOpen] = useState(false);
  const [complaintsOpen, setComplaintsOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  if (!me) return null;

  const unclaimed = (me.mailbox || []).filter((m) => !m.claimed).length;
  const pendingComplaints = (me.complaints || []).length;
  const pendingTransferRequests = (me.transferRequests || []).length;

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
        <button type="button" className="btn ghost small mailbox-btn" onClick={() => setComplaintsOpen(true)}>
          😠 <span className={'mailbox-badge' + (pendingComplaints ? '' : ' hidden')}>{pendingComplaints}</span>
        </button>
        <button type="button" className="btn ghost small mailbox-btn" onClick={() => setTransferOpen(true)}>
          ✈️ <span className={'mailbox-badge' + (pendingTransferRequests ? '' : ' hidden')}>{pendingTransferRequests}</span>
        </button>
        <button type="button" className="btn ghost small" onClick={logout}>
          로그아웃
        </button>
      </div>
      {mailOpen && <MailboxModal onClose={() => setMailOpen(false)} />}
      {complaintsOpen && <ComplaintsModal onClose={() => setComplaintsOpen(false)} />}
      {transferOpen && <TransferRequestModal onClose={() => setTransferOpen(false)} />}
    </header>
  );
}
