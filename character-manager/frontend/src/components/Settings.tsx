import { getDataSource } from '../api/client';
import ModelArkSettings from './ModelArkSettings';
import './Settings.css';

interface Props {
  dataSource: string;
  sources: string[];
  onDataSourceChange: (v: string) => void;
  confirmEnabled: boolean;
  onToggleConfirm: (enabled: boolean) => void;
  allowHardDelete: boolean;
  onToggleHardDelete: (enabled: boolean) => void;
}

export default function Settings({
  dataSource, sources, onDataSourceChange, confirmEnabled, onToggleConfirm, allowHardDelete, onToggleHardDelete,
}: Props) {
  return (
    <div className="settings-page">
      <h1 className="settings-title cv-display-title">设置 / Settings</h1>
      <p className="settings-subtitle">Character Manager 运行偏好（保存在本地浏览器）。</p>

      <div className="settings-sections">
        {/* Data source */}
        <section className="settings-section">
          <h3 className="settings-section-title">数据源 / Data Source</h3>
          <p className="settings-section-hint">切换后台读写的数据库。切换会重置当前视图并重新加载。</p>
          <label className="settings-field">
            <span className="settings-label">当前数据源</span>
            {sources.length > 0 ? (
              <select
                className="settings-input"
                value={dataSource}
                onChange={e => onDataSourceChange(e.target.value)}
              >
                {sources.map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            ) : (
              <input className="settings-input" value={dataSource} readOnly />
            )}
          </label>
        </section>

        {/* Confirm behavior */}
        <section className="settings-section">
          <h3 className="settings-section-title">操作确认 / Action Confirmation</h3>
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <span className="settings-toggle-label">二次确认</span>
              <span className="settings-toggle-hint">
                {confirmEnabled ? '丢弃 / 采用前弹出确认框（彻底删除始终需确认）' : '点击即执行，不再弹确认框'}
              </span>
            </div>
            <button
              className={`settings-switch ${confirmEnabled ? 'on' : ''}`}
              onClick={() => onToggleConfirm(!confirmEnabled)}
              role="switch"
              aria-checked={confirmEnabled}
            >
              <span className="settings-switch-knob" />
            </button>
          </div>
        </section>

        {/* Permanent delete */}
        <section className="settings-section">
          <h3 className="settings-section-title">永久删除 / Permanent Delete</h3>
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <span className="settings-toggle-label">允许永久删除</span>
              <span className="settings-toggle-hint">
                {allowHardDelete ? '可对图片/视频永久删除（含 OSS 文件，不可恢复）' : '仅软删除到回收站；永久删除按钮隐藏'}
              </span>
            </div>
            <button
              className={`settings-switch ${allowHardDelete ? 'on' : ''}`}
              onClick={() => onToggleHardDelete(!allowHardDelete)}
              role="switch"
              aria-checked={allowHardDelete}
            >
              <span className="settings-switch-knob" />
            </button>
          </div>
        </section>

        {/* ModelArk portrait library binding */}
        <ModelArkSettings />

        {/* System info (read-only) */}
        <section className="settings-section">
          <h3 className="settings-section-title">系统信息 / System Info</h3>
          <div className="settings-info-grid cv-mono">
            <span className="settings-info-key">后端 API</span>
            <span className="settings-info-val">/api → :8889 (FastAPI)</span>
            <span className="settings-info-key">数据源标识</span>
            <span className="settings-info-val">X-Data-Source: {getDataSource()}</span>
            <span className="settings-info-key">前端</span>
            <span className="settings-info-val">React 19 · Vite · CyberVerse UI</span>
          </div>
        </section>
      </div>
    </div>
  );
}
