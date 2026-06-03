import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import './CustomBatchPanel.css';

interface ScriptDef {
  key: string;
  label: string;
  category: string;
  description: string;
  needs_args: boolean;
  default_args: Record<string, string>;
  positional_args: string[];
}

interface ScriptJob {
  job_id: string;
  script_key: string;
  label: string;
  character_name: string;
  pid: number;
  status: string;
  exit_code: number | null;
  started_at: string;
  completed_at: string | null;
  log_tail: string;
}

interface Props {
  characterName: string;
}

export default function CustomBatchPanel({ characterName }: Props) {
  const [scripts, setScripts] = useState<ScriptDef[]>([]);
  const [jobs, setJobs] = useState<ScriptJob[]>([]);
  const [selectedScript, setSelectedScript] = useState<string>('');
  const [customArgs, setCustomArgs] = useState<Record<string, string>>({});
  const [launching, setLaunching] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [fullLog, setFullLog] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.listScripts().then(d => {
      setScripts(d.scripts);
      if (d.scripts.length > 0) setSelectedScript(d.scripts[0]!.key);
    });
    loadJobs();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [characterName]);

  // Poll jobs every 5s
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === 'running');
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(loadJobs, 5000);
    }
    if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobs]);

  const loadJobs = async () => {
    try {
      const d = await api.getScriptJobs(characterName);
      setJobs(d.jobs);
    } catch {}
  };

  const currentScript = scripts.find(s => s.key === selectedScript);

  useEffect(() => {
    if (currentScript) {
      const defaults: Record<string, string> = { ...currentScript.default_args };
      for (const p of currentScript.positional_args) {
        defaults[p] = defaults[p] || '';
      }
      setCustomArgs(defaults);
    }
  }, [selectedScript]);

  const handleLaunch = async () => {
    if (!selectedScript) return;
    setLaunching(true);
    try {
      const res = await api.launchScript(selectedScript, characterName, customArgs);
      if (res.status === 'ok') {
        await loadJobs();
      } else {
        alert('启动失败: ' + (res.message || '未知错误'));
      }
    } catch (e: any) {
      alert('启动失败: ' + e.message);
    } finally {
      setLaunching(false);
    }
  };

  const handleKill = async (job_id: string) => {
    if (!confirm('确认终止此任务？')) return;
    try {
      await api.killScriptJob(job_id);
      await loadJobs();
    } catch (e: any) {
      alert('终止失败: ' + e.message);
    }
  };

  const handleViewLog = async (job_id: string) => {
    if (expandedJob === job_id) {
      setExpandedJob(null);
      return;
    }
    try {
      const d = await api.getScriptJobStatus(job_id);
      setFullLog(d.log_tail || '(no output)');
      setExpandedJob(job_id);
    } catch (e: any) {
      setFullLog('Error: ' + e.message);
      setExpandedJob(job_id);
    }
  };

  const statusIcon = (s: string) => {
    if (s === 'running') return '⏳';
    if (s === 'completed') return '✅';
    if (s === 'failed') return '❌';
    if (s === 'killed') return '💀';
    return '❓';
  };

  return (
    <div className="cb-panel">
      {/* Script selector */}
      <div className="cb-section">
        <div className="cb-section-title">自定义批处理</div>
        <div className="cb-script-grid">
          {scripts.map(s => (
            <button
              key={s.key}
              className={`cb-script-btn ${selectedScript === s.key ? 'active' : ''} cb-cat-${s.category}`}
              onClick={() => setSelectedScript(s.key)}
            >
              <span className="cb-script-label">{s.label}</span>
              <span className="cb-script-desc">{s.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Args config */}
      {currentScript && (Object.keys(currentScript.default_args).length > 0 || currentScript.positional_args.length > 0) && (
        <div className="cb-section">
          <div className="cb-section-title">参数配置 — {currentScript.label}</div>
          <div className="cb-args">
            {currentScript.positional_args.map(p => (
              <div className="cb-arg-row" key={p}>
                <label>{p}:</label>
                <input
                  value={customArgs[p] || ''}
                  onChange={e => setCustomArgs(prev => ({ ...prev, [p]: e.target.value }))}
                  placeholder={p}
                />
              </div>
            ))}
            {Object.entries(currentScript.default_args).map(([k, v]) => (
              <div className="cb-arg-row" key={k}>
                <label>{k}:</label>
                <input
                  value={customArgs[k] || ''}
                  onChange={e => setCustomArgs(prev => ({ ...prev, [k]: e.target.value }))}
                  placeholder={v}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Launch button */}
      <div className="cb-section">
        <button
          className="cb-launch-btn"
          onClick={handleLaunch}
          disabled={launching || !selectedScript}
        >
          {launching ? '启动中...' : `🚀 启动 ${currentScript?.label || '脚本'}`}
        </button>
      </div>

      {/* Jobs list */}
      {jobs.length > 0 && (
        <div className="cb-section">
          <div className="cb-section-title">
            任务列表 ({jobs.filter(j => j.status === 'running').length} 运行中)
            <button className="cb-refresh-btn" onClick={loadJobs}>🔄</button>
          </div>
          <div className="cb-jobs">
            {jobs.map(j => (
              <div key={j.job_id} className={`cb-job cb-job-${j.status}`}>
                <div className="cb-job-header">
                  <span className="cb-job-status">{statusIcon(j.status)} {j.status}</span>
                  <span className="cb-job-label">{j.label}</span>
                  <span className="cb-job-time">
                    {j.started_at ? new Date(j.started_at).toLocaleTimeString() : ''}
                  </span>
                  <div className="cb-job-actions">
                    {j.status === 'running' && (
                      <button className="cb-kill-btn" onClick={() => handleKill(j.job_id)}>🛑 终止</button>
                    )}
                    <button className="cb-log-btn" onClick={() => handleViewLog(j.job_id)}>
                      {expandedJob === j.job_id ? '收起' : '📋 日志'}
                    </button>
                  </div>
                </div>
                {j.log_tail && expandedJob !== j.job_id && (
                  <pre className="cb-job-log-preview">{j.log_tail.slice(-120)}</pre>
                )}
                {expandedJob === j.job_id && (
                  <pre className="cb-job-log-full">{fullLog || '加载中...'}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
