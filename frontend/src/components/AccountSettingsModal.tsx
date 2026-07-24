import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { avatarSrc } from '../config';
import { toast } from '../store/useToastStore';

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

export default function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const { me, changePassword, setAvatar, clearAvatar } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const src = me ? avatarSrc(me.avatarUrl) : null;
  useEffect(() => {
    setAvatarBroken(false);
  }, [src]);

  if (!me) return null;

  const onSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 4) {
      toast('새 비밀번호는 4자 이상이어야 합니다.');
      return;
    }
    if (newPassword !== newPassword2) {
      toast('새 비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    setPwBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast('비밀번호가 변경되었습니다.');
      setCurrentPassword('');
      setNewPassword('');
      setNewPassword2('');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setPwBusy(false);
    }
  };

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast('PNG, JPEG, WEBP 이미지만 업로드할 수 있습니다.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast('이미지 용량은 3MB 이하여야 합니다.');
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      await setAvatar(dataUrl);
      toast('프로필 사진이 변경되었습니다.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  const onRemoveAvatar = async () => {
    setAvatarBusy(true);
    try {
      await clearAvatar();
      toast('프로필 사진을 제거했습니다.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div
      id="account-settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nego-modal">
        <div className="picker-head">
          <span>⚙️ 계정 설정</span>
          <button type="button" className="btn ghost small" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="account-section">
          <h4>프로필 사진</h4>
          <div className="account-avatar-row">
            <div className="account-avatar-preview">
              {src && !avatarBroken ? (
                <img src={src} alt="" onError={() => setAvatarBroken(true)} />
              ) : (
                <span className="account-avatar-placeholder">{me.username.slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <div className="account-avatar-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={onPickAvatar}
              />
              <button type="button" className="btn small" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
                사진 업로드
              </button>
              {me.avatarUrl && (
                <button type="button" className="btn ghost small" disabled={avatarBusy} onClick={onRemoveAvatar}>
                  제거
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="account-section">
          <h4>비밀번호 변경</h4>
          <form onSubmit={onSubmitPassword} className="account-password-form" autoComplete="off">
            <input
              type="password"
              placeholder="현재 비밀번호"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <input
              type="password"
              placeholder="새 비밀번호 (4자 이상)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              type="password"
              placeholder="새 비밀번호 확인"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
            />
            <button type="submit" className="btn primary small" disabled={pwBusy}>
              비밀번호 변경
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
