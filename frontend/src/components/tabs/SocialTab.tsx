import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../../store/useToastStore';
import type { FriendsView, Guild, GuildListItem, User } from '../../types';

// backend/guild.js의 MAX_MEMBERS와 같은 값으로 유지 — 정원 표시용.
const MAX_GUILD_MEMBERS = 20;

type SubTab = 'friends' | 'guild';

export default function SocialTab() {
  const [sub, setSub] = useState<SubTab>('friends');
  const me = useAppStore((s) => s.me);
  const [friendsCount, setFriendsCount] = useState(0);

  useEffect(() => {
    api
      .get<FriendsView>('/api/social/friends')
      .then((v) => setFriendsCount(v.incoming.length))
      .catch(() => {});
  }, []);

  if (!me) return null;

  return (
    <div id="tab-social" className="tab-panel">
      <nav className="sub-tabs">
        <button type="button" className={sub === 'friends' ? 'active' : ''} onClick={() => setSub('friends')}>
          <span className="subtab-badge-wrap">
            친구
            {friendsCount > 0 && <span className="mailbox-badge">{friendsCount}</span>}
          </span>
        </button>
        <button type="button" className={sub === 'guild' ? 'active' : ''} onClick={() => setSub('guild')}>
          길드
        </button>
      </nav>
      <div className="rank-sub" style={{ display: sub === 'friends' ? undefined : 'none' }}>
        {sub === 'friends' && <FriendsSub onCountChange={setFriendsCount} />}
      </div>
      <div className="rank-sub" style={{ display: sub === 'guild' ? undefined : 'none' }}>
        {sub === 'guild' && <GuildSub me={me} />}
      </div>
    </div>
  );
}

function FriendsSub({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [view, setView] = useState<FriendsView>({ friends: [], incoming: [], outgoing: [] });
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = () => {
    api
      .get<FriendsView>('/api/social/friends')
      .then((v) => {
        setView(v);
        onCountChange(v.incoming.length);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  const call = async (path: string, body?: unknown) => {
    try {
      const v = await api.post<FriendsView>(path, body);
      setView(v);
      onCountChange(v.incoming.length);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const sendRequest = async () => {
    const name = username.trim();
    if (!name) return;
    await call('/api/social/friend-request', { username: name });
    setUsername('');
  };

  if (loading) return <p className="dim small-text">불러오는 중...</p>;

  return (
    <div className="rank-layout">
      <div>
        <h3>👥 친구</h3>
        <div className="social-add-row">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="유저 닉네임"
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendRequest();
            }}
          />
          <button type="button" className="btn small primary" onClick={sendRequest}>
            친구 요청
          </button>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>구단</th>
                <th>승점</th>
                <th>승-무-패</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.friends.length ? (
                view.friends.map((f, i) => (
                  <tr key={f.id}>
                    <td>{i + 1}</td>
                    <td>
                      {f.clubName} <span className="dim small-text">({f.username})</span>
                    </td>
                    <td className="num">{f.points}</td>
                    <td>
                      {f.record.w}-{f.record.d}-{f.record.l}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => call('/api/social/friend-remove', { userId: f.id })}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="dim small-text">
                    아직 친구가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3>📨 친구 요청</h3>
        <div className="team-block">
          <h4>받은 요청</h4>
          <ol className="mini-board">
            {view.incoming.length ? (
              view.incoming.map((f) => (
                <li key={f.id}>
                  <span>
                    {f.clubName} <span className="dim small-text">({f.username})</span>
                  </span>
                  <span className="social-req-actions">
                    <button
                      type="button"
                      className="btn small primary"
                      onClick={() => call('/api/social/friend-accept', { userId: f.id })}
                    >
                      수락
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => call('/api/social/friend-decline', { userId: f.id })}
                    >
                      거절
                    </button>
                  </span>
                </li>
              ))
            ) : (
              <li className="dim">받은 요청이 없습니다.</li>
            )}
          </ol>
        </div>
        <div className="team-block">
          <h4>보낸 요청</h4>
          <ol className="mini-board">
            {view.outgoing.length ? (
              view.outgoing.map((f) => (
                <li key={f.id}>
                  <span>
                    {f.clubName} <span className="dim small-text">({f.username})</span>
                  </span>
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => call('/api/social/friend-cancel', { userId: f.id })}
                  >
                    취소
                  </button>
                </li>
              ))
            ) : (
              <li className="dim">보낸 요청이 없습니다.</li>
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}

function GuildSub({ me }: { me: User }) {
  const [guild, setGuild] = useState<Guild | null>(null);
  const [list, setList] = useState<GuildListItem[]>([]);
  const [leaderboard, setLeaderboard] = useState<Guild[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');

  const reload = () => {
    setLoading(true);
    Promise.all([
      api.get<{ guild: Guild | null }>('/api/guild/mine'),
      api.get<{ guilds: GuildListItem[] }>('/api/guild/list'),
      api.get<{ leaderboard: Guild[] }>('/api/guild/leaderboard'),
    ])
      .then(([mine, l, lb]) => {
        setGuild(mine.guild);
        setList(l.guilds);
        setLeaderboard(lb.leaderboard);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  if (loading) return <p className="dim small-text">불러오는 중...</p>;

  const isOwner = !!guild && guild.ownerId === me.id;

  const create = async () => {
    if (!name.trim() || !tag.trim()) {
      toast('길드 이름과 태그를 입력해주세요.');
      return;
    }
    try {
      const r = await api.post<{ user: User; guild: Guild }>('/api/guild/create', {
        name: name.trim(),
        tag: tag.trim(),
      });
      useAppStore.getState().setMe(r.user);
      setGuild(r.guild);
      toast('길드를 만들었습니다!');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const requestJoin = async (guildId: string) => {
    try {
      await api.post('/api/guild/request-join', { guildId });
      toast('가입 신청을 보냈습니다. 길드장 승인을 기다려주세요.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const approve = async (userId: string) => {
    try {
      const r = await api.post<{ guild: Guild }>('/api/guild/approve', { userId });
      setGuild(r.guild);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const reject = async (userId: string) => {
    try {
      await api.post('/api/guild/reject', { userId });
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const leave = async () => {
    if (!confirm('정말 길드를 탈퇴하시겠습니까?')) return;
    try {
      const r = await api.post<{ user: User }>('/api/guild/leave');
      useAppStore.getState().setMe(r.user);
      setGuild(null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rank-layout">
      <div>
        {guild ? (
          <>
            <h3>
              🛡️ {guild.name} <span className="dim small-text">[{guild.tag}]</span>
            </h3>
            <p className="dim small-text">
              멤버 {guild.members.length}/{MAX_GUILD_MEMBERS}명 · 길드 총점 {guild.totalPoints}
            </p>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>구단</th>
                    <th>승점</th>
                  </tr>
                </thead>
                <tbody>
                  {guild.members.map((m, i) => (
                    <tr key={m.id} style={m.id === me.id ? { color: 'var(--gold)' } : undefined}>
                      <td>{i + 1}</td>
                      <td>
                        {m.clubName} <span className="dim small-text">({m.username})</span>
                        {m.id === guild.ownerId ? ' 👑' : ''}
                      </td>
                      <td className="num">{m.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isOwner && guild.pending.length > 0 && (
              <div className="team-block">
                <h4>가입 신청 대기 중 ({guild.pending.length})</h4>
                <ol className="mini-board">
                  {guild.pending.map((p) => (
                    <li key={p.id}>
                      <span>
                        {p.clubName} <span className="dim small-text">({p.username})</span>
                      </span>
                      <span className="social-req-actions">
                        <button type="button" className="btn small primary" onClick={() => approve(p.id)}>
                          승인
                        </button>
                        <button type="button" className="btn small ghost" onClick={() => reject(p.id)}>
                          거절
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <button type="button" className="btn ghost small" onClick={leave}>
              길드 탈퇴
            </button>
          </>
        ) : (
          <>
            <h3>🛡️ 길드 만들기</h3>
            <div className="social-add-row">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="길드 이름" maxLength={24} />
              <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="태그" maxLength={6} />
              <button type="button" className="btn small primary" onClick={create}>
                만들기
              </button>
            </div>
            <h4>가입 가능한 길드</h4>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>길드</th>
                    <th>멤버</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.length ? (
                    list.map((g) => (
                      <tr key={g.id}>
                        <td>
                          {g.name} <span className="dim small-text">[{g.tag}]</span>
                        </td>
                        <td>
                          {g.memberCount}/{MAX_GUILD_MEMBERS}
                        </td>
                        <td>
                          <button type="button" className="btn small primary" onClick={() => requestJoin(g.id)}>
                            가입 신청
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="dim small-text">
                        아직 생성된 길드가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div>
        <h3>🏆 길드 랭킹</h3>
        <ol className="mini-board">
          {leaderboard.length ? (
            leaderboard.map((g, i) => (
              <li key={g.id} style={guild && g.id === guild.id ? { color: 'var(--gold)' } : undefined}>
                #{i + 1} {g.name} <span className="dim small-text">[{g.tag}]</span> — {g.totalPoints}점
              </li>
            ))
          ) : (
            <li className="dim">아직 랭킹이 없습니다.</li>
          )}
        </ol>
      </div>
    </div>
  );
}
