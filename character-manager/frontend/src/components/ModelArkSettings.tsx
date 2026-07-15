import { useState, useEffect } from 'react';
import { api, type ModelArkCfg } from '../api/client';

const DEFAULTS: ModelArkCfg = {
  enabled: true,
  api_key: '',
  endpoint_id: '',
  base_url: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  access_key_id: '',
  secret_access_key: '',
  host: 'open.byteplusapi.com',
  region: 'ap-southeast-1',
  moderation_skip: false,
  project: 'default',
};

export default function ModelArkSettings() {
  const [cfg, setCfg] = useState<ModelArkCfg>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.getModelArkConfig()
      .then(r => { if (r.config) setCfg({ ...DEFAULTS, ...r.config }); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof ModelArkCfg>(k: K, v: ModelArkCfg[K]) =>
    setCfg(c => ({ ...c, [k]: v }));

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const r = await api.saveModelArkConfig(cfg);
      if (r.status === 'ok') { setMsg('已保存 ✓'); if (r.config) setCfg({ ...DEFAULTS, ...r.config }); }
      else setMsg('保存失败');
    } catch (e: any) {
      setMsg('保存异常: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (k: 'enabled' | 'moderation_skip', label: string, hintOn: string, hintOff: string) => (
    <div className="settings-toggle-row">
      <div className="settings-toggle-text">
        <span className="settings-toggle-label">{label}</span>
        <span className="settings-toggle-hint">{cfg[k] ? hintOn : hintOff}</span>
      </div>
      <button
        className={`settings-switch ${cfg[k] ? 'on' : ''}`}
        onClick={() => set(k, !cfg[k])}
        role="switch"
        aria-checked={cfg[k]}
      >
        <span className="settings-switch-knob" />
      </button>
    </div>
  );

  const field = (k: keyof ModelArkCfg, label: string, secret = false) => (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <input
        className="settings-input"
        type={secret ? 'password' : 'text'}
        value={String(cfg[k] ?? '')}
        onChange={e => set(k, e.target.value as never)}
      />
    </label>
  );

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">字节 ModelArk 人像库 / Portrait Library</h3>
      <p className="settings-section-hint">
        启用后，在付费素材 / Profile 的批量选择工具栏点「→ ModelArk 人像库」即可把选中图推送到私有素材库（供 Seedance 2.0 视频生成用 asset:// 引用）。凭证保存在后端。
      </p>
      {loading ? (
        <p className="settings-section-hint">加载中…</p>
      ) : (
        <>
          {toggle('enabled', '启用绑定', '已启用，可推送', '未启用，推送会返回未启用')}
          {toggle('moderation_skip', '跳过内容审核（成人素材）',
            '推送带 Moderation:Skip（需先在 ModelArk 控制台关闭内容预过滤）',
            '默认走内容预过滤，敏感图会被拦(InputImageSensitiveContentDetected)')}
          {field('project', 'Project 项目名（资产上传/引用同项目）')}
          {field('access_key_id', 'Access Key ID (AK · 素材库签名)')}
          {field('secret_access_key', 'Secret Access Key (SK)', true)}
          {field('host', 'Host')}
          {field('region', 'Region')}
          {field('api_key', 'ARK API Key（推理/视频生成用）', true)}
          {field('endpoint_id', 'Endpoint ID（Seedance）')}
          {field('base_url', 'Base URL（推理）')}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <button
              className="cv-pi-button cv-pi-button--primary cv-pi-button--compact"
              onClick={save}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {msg && <span style={{ fontSize: 12, color: '#6a7' }}>{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}
