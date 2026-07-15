import { useState } from 'react';
import { api, setAuth } from '../api/client';

export default function AuthGate({ onAuthed }: { onAuthed: (user: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setErr('请填写用户名和密码'); return; }
    setBusy(true); setErr('');
    try {
      const r = mode === 'login'
        ? await api.authLogin(username.trim(), password)
        : await api.authRegister(username.trim(), password, invite.trim());
      if (r.status === 'ok' && r.token && r.username) {
        setAuth(r.token, r.username);
        onAuthed(r.username);
      } else {
        setErr(r.message || '失败');
      }
    } catch (e: any) {
      setErr('网络错误: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', marginTop: 6,
    background: '#0e1526', border: '1px solid #2a3550', borderRadius: 6,
    color: '#dfe7ff', fontSize: 14, boxSizing: 'border-box',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0f1e', color: '#dfe7ff', fontFamily: 'system-ui, sans-serif',
    }}>
      <form onSubmit={submit} style={{
        width: 340, padding: 28, background: '#111a30',
        border: '1px solid #223', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,.4)',
      }}>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>
          CYPHER<span style={{ color: '#5ad' }}>·CM</span>
        </div>
        <div style={{ fontSize: 12, color: '#8a9', marginTop: 4, marginBottom: 18 }}>
          Character Manager · {mode === 'login' ? '登录' : '注册'}
        </div>

        <label style={{ fontSize: 12, color: '#9ab' }}>用户名
          <input style={inputStyle} value={username} onChange={e => setUsername(e.target.value)}
            autoFocus autoComplete="username" />
        </label>
        <label style={{ fontSize: 12, color: '#9ab', display: 'block', marginTop: 14 }}>密码
          <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {mode === 'register' && (
          <label style={{ fontSize: 12, color: '#9ab', display: 'block', marginTop: 14 }}>邀请码
            <input style={inputStyle} value={invite} onChange={e => setInvite(e.target.value)} placeholder="注册需要邀请码" />
          </label>
        )}

        {err && <div style={{ color: '#f77', fontSize: 12, marginTop: 12 }}>{err}</div>}

        <button type="submit" disabled={busy} style={{
          width: '100%', marginTop: 20, padding: '11px', border: 'none', borderRadius: 6,
          background: busy ? '#345' : '#3b82f6', color: '#fff', fontSize: 15, fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
        }}>
          {busy ? '…' : (mode === 'login' ? '登录' : '注册并登录')}
        </button>

        <div style={{ fontSize: 12, color: '#9ab', marginTop: 16, textAlign: 'center' }}>
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
          <a onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}
            style={{ color: '#5ad', cursor: 'pointer', marginLeft: 6 }}>
            {mode === 'login' ? '去注册' : '去登录'}
          </a>
        </div>
      </form>
    </div>
  );
}
