import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import './BatchCharacterPanel.css';

interface Props {
  onBack: () => void;
  onRefresh?: () => void;
}

type Category = 'girlfriend' | 'boyfriend' | 'anime_female' | 'anime_male';

interface GenChar {
  name: string;
  category: string;
  description: string;
  attributes: Record<string, string>;
}

interface WriteResult {
  total: number;
  written: number;
  skipped_duplicates: number;
  selected: number;
}

interface PreviewCache {
  category: Category;
  count: number;
  batchSize: number;
  characters: GenChar[];
  createdAt: string;
}

const CACHE_KEY = 'batch_char_preview';

const loadPreviewCache = (): PreviewCache | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PreviewCache;
    if (!data || !Array.isArray(data.characters) || data.characters.length === 0) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

const savePreviewCache = (data: PreviewCache) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    /* ignore quota / privacy mode errors */
  }
};

const clearPreviewCache = () => {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
};

const CATEGORIES: { value: Category; label: string; sub: string }[] = [
  { value: 'girlfriend', label: 'Girlfriend', sub: '真人女性' },
  { value: 'boyfriend', label: 'Boyfriend', sub: '真人男性' },
  { value: 'anime_female', label: 'Anime ♀', sub: '动漫女性' },
  { value: 'anime_male', label: 'Anime ♂', sub: '动漫男性' },
];

const KEY_ATTRS = ['Age', 'Occupation', 'Ethnicity', 'Personality'];

export default function BatchCharacterPanel({ onBack, onRefresh }: Props) {
  const [category, setCategory] = useState<Category>('girlfriend');
  const [count, setCount] = useState<number>(10);
  const [batchSize, setBatchSize] = useState<number>(5);

  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string>('');
  const [preview, setPreview] = useState<GenChar[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [elapsed, setElapsed] = useState<number>(0);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [restoredInfo, setRestoredInfo] = useState<{ count: number; createdAt: string } | null>(null);
  const restoredRef = useRef(false);

  // 组件挂载时尝试从 localStorage 恢复上次的预览
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const cache = loadPreviewCache();
    if (!cache) return;
    setCategory(cache.category);
    setCount(cache.count);
    setBatchSize(cache.batchSize);
    setPreview(cache.characters);
    setSelected(new Set(cache.characters.map((_, i) => i)));
    setRestoredInfo({ count: cache.characters.length, createdAt: cache.createdAt });
  }, []);

  const allChecked = preview.length > 0 && selected.size === preview.length;

  const selectedCount = selected.size;
  const selectedChars = useMemo(
    () => preview.filter((_, i) => selected.has(i)),
    [preview, selected]
  );

  const startTimer = () => {
    setElapsed(0);
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
  };

  const handlePreview = async () => {
    setError('');
    setResult(null);
    setRestoredInfo(null);
    setLoading(true);
    setPreview([]);
    setSelected(new Set());
    const stop = startTimer();
    try {
      const res = await api.generateCharacters({
        category,
        count,
        write_db: false,
        batch_size: batchSize,
      });
      const chars = res.characters || [];
      setPreview(chars);
      // 默认全选，方便用户直接写入
      setSelected(new Set(chars.map((_, i) => i)));
      // 持久化到 localStorage，避免离开页面后丢失
      if (chars.length > 0) {
        savePreviewCache({
          category,
          count,
          batchSize,
          characters: chars,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e: any) {
      setError(e?.message || '生成失败，请检查后端服务与网络');
    } finally {
      stop();
      setLoading(false);
    }
  };

  const toggleOne = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(preview.map((_, i) => i)));
  };

  const handleWrite = async () => {
    if (selectedCount === 0) return;
    if (
      !confirm(
        `将向数据库写入 ${selectedCount} 个 ${category} 角色（character_status=pending）。\n\n` +
        `本次仅落库你勾选的预览角色，不会再次调用 AI 生成新角色。\n\n继续？`
      )
    ) return;

    setError('');
    setWriting(true);
    setResult(null);
    const stop = startTimer();
    try {
      const payload = selectedChars.map(c => ({
        name: c.name,
        description: c.description,
        category: c.category,
        attributes: c.attributes,
      }));
      const res = await api.saveCharacters(payload);
      setResult({
        total: res.total,
        written: res.written,
        skipped_duplicates: res.skipped_duplicates,
        selected: selectedCount,
      });
      // 写入完成后清空勾选，但保留预览，方便继续筛选/补写
      setSelected(new Set());
      // 写入成功后清掉持久化缓存，避免下次进入再被恢复
      clearPreviewCache();
      setRestoredInfo(null);
      onRefresh?.();
    } catch (e: any) {
      setError(e?.message || '写入失败');
    } finally {
      stop();
      setWriting(false);
    }
  };

  const handleClear = () => {
    setPreview([]);
    setSelected(new Set());
    setResult(null);
    setError('');
    clearPreviewCache();
    setRestoredInfo(null);
  };

  const renderAttr = (c: GenChar, key: string) => {
    const v = c.attributes?.[key];
    if (!v) return null;
    return (
      <div className="bcp-attr" key={key}>
        <span className="bcp-attr-key">{key}</span>
        <span className="bcp-attr-val" title={v}>{v}</span>
      </div>
    );
  };

  const renderCard = (c: GenChar, i: number) => {
    const isSelected = selected.has(i);
    const expanded = expandedIdx === i;
    const desc = c.description || '';
    const shortDesc = desc.length > 100 ? desc.slice(0, 100) + '…' : desc;

    return (
      <div
        key={i}
        className={`bcp-card ${isSelected ? 'selected' : ''}`}
        onClick={() => toggleOne(i)}
      >
        <div className="bcp-card-head">
          <label className="bcp-checkbox" onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleOne(i)}
            />
            <span className="bcp-checkbox-box" aria-hidden />
          </label>
          <div className="bcp-card-name" title={c.name}>{c.name}</div>
          <span className="bcp-card-cat">{c.category}</span>
        </div>

        <p className="bcp-card-desc">
          {expanded ? desc : shortDesc}
          {desc.length > 100 && (
            <button
              className="bcp-link-btn"
              onClick={e => {
                e.stopPropagation();
                setExpandedIdx(expanded ? null : i);
              }}
            >
              {expanded ? ' 收起' : ' 展开'}
            </button>
          )}
        </p>

        <div className="bcp-attrs">
          {KEY_ATTRS.map(k => renderAttr(c, k))}
        </div>
      </div>
    );
  };

  return (
    <div className="bcp">
      <div className="bcp-header">
        <button className="bcp-back-btn" onClick={onBack}>← 返回</button>
        <div className="bcp-title">
          <h2>批量生成角色</h2>
          <span className="bcp-subtitle">
            DashScope 生成 → 预览 → 选择性写入 ecjoy 数据库
          </span>
        </div>
      </div>

      <div className="bcp-form">
        <div className="bcp-row">
          <label className="bcp-label">分类</label>
          <div className="bcp-cat-grid">
            {CATEGORIES.map(c => (
              <button
                key={c.value}
                className={`bcp-cat-chip ${category === c.value ? 'active' : ''}`}
                onClick={() => setCategory(c.value)}
                disabled={loading || writing}
              >
                <span className="bcp-cat-chip-label">{c.label}</span>
                <span className="bcp-cat-chip-sub">{c.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="bcp-row bcp-row-numbers">
          <div className="bcp-num">
            <label className="bcp-label">生成数量</label>
            <div className="bcp-num-input">
              <button
                onClick={() => setCount(c => Math.max(1, c - 1))}
                disabled={loading || writing || count <= 1}
              >−</button>
              <input
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={e => {
                  const n = Number(e.target.value) || 1;
                  setCount(Math.max(1, Math.min(20, n)));
                }}
                disabled={loading || writing}
              />
              <button
                onClick={() => setCount(c => Math.min(20, c + 1))}
                disabled={loading || writing || count >= 20}
              >+</button>
            </div>
            <span className="bcp-help">范围 1–20</span>
          </div>

          <div className="bcp-num">
            <label className="bcp-label">每批 batch_size</label>
            <div className="bcp-num-input">
              <button
                onClick={() => setBatchSize(b => Math.max(1, b - 1))}
                disabled={loading || writing || batchSize <= 1}
              >−</button>
              <input
                type="number"
                min={1}
                max={20}
                value={batchSize}
                onChange={e => {
                  const n = Number(e.target.value) || 1;
                  setBatchSize(Math.max(1, Math.min(20, n)));
                }}
                disabled={loading || writing}
              />
              <button
                onClick={() => setBatchSize(b => Math.min(20, b + 1))}
                disabled={loading || writing || batchSize >= 20}
              >+</button>
            </div>
            <span className="bcp-help">越小越稳；越大越省调用</span>
          </div>

          <div className="bcp-actions">
            <button
              className="bcp-primary-btn"
              onClick={handlePreview}
              disabled={loading || writing}
            >
              {loading ? `生成中… ${elapsed}s` : '生成预览'}
            </button>
            {preview.length > 0 && !loading && !writing && (
              <button className="bcp-ghost-btn" onClick={handleClear}>清空结果</button>
            )}
          </div>
        </div>
      </div>

      {restoredInfo && (
        <div className="bcp-toast bcp-toast-info">
          <span className="bcp-toast-dot" />
          已恢复上次生成的 <b className="bcp-num-em">{restoredInfo.count}</b> 个角色预览
          <span className="bcp-toast-meta">
            （{new Date(restoredInfo.createdAt).toLocaleString()}）
          </span>
          <button
            className="bcp-link-btn bcp-toast-action"
            onClick={handleClear}
          >
            清除历史预览
          </button>
        </div>
      )}

      {error && (
        <div className="bcp-toast bcp-toast-err">
          <span className="bcp-toast-dot" /> {error}
        </div>
      )}

      {result && (
        <div className="bcp-toast bcp-toast-ok">
          <span className="bcp-toast-dot" />
          写入完成：选择 <b>{result.selected}</b> · 后端生成 <b>{result.total}</b> · 实际入库
          {' '}<b className="bcp-num-em">{result.written}</b>
          {' '}· 跳过重名 <b>{result.skipped_duplicates}</b>
        </div>
      )}

      {loading && preview.length === 0 && (
        <div className="bcp-loading">
          <div className="bcp-spinner" />
          <div className="bcp-loading-title">正在生成 {count} 个 {category} 角色…</div>
          <div className="bcp-loading-hint">
            预计 30–60 秒，请勿刷新页面。已耗时 <b>{elapsed}s</b>
          </div>
          <div className="bcp-skeleton-grid">
            {Array.from({ length: Math.min(count, 6) }).map((_, i) => (
              <div className="bcp-skeleton-card" key={i}>
                <div className="bcp-sk-line w-60" />
                <div className="bcp-sk-line w-90" />
                <div className="bcp-sk-line w-80" />
                <div className="bcp-sk-grid">
                  <div className="bcp-sk-pill" />
                  <div className="bcp-sk-pill" />
                  <div className="bcp-sk-pill" />
                  <div className="bcp-sk-pill" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview.length > 0 && (
        <>
          <div className="bcp-toolbar">
            <div className="bcp-toolbar-left">
              <button className="bcp-toggle-all" onClick={toggleAll}>
                <span className={`bcp-mini-check ${allChecked ? 'on' : ''}`} />
                {allChecked ? '取消全选' : '全选'}
              </button>
              <span className="bcp-counter">
                已选 <b className="bcp-num-em">{selectedCount}</b> / {preview.length}
              </span>
            </div>
            <div className="bcp-toolbar-right">
              <button
                className="bcp-write-btn"
                onClick={handleWrite}
                disabled={writing || selectedCount === 0}
              >
                {writing ? `写入中… ${elapsed}s` : `写入数据库 (${selectedCount})`}
              </button>
            </div>
          </div>

          <div className="bcp-grid">
            {preview.map((c, i) => renderCard(c, i))}
          </div>

          {selectedChars.length > 0 && !writing && (
            <div className="bcp-foot-hint">
              提示：写入按钮调用 <code>POST /api/generation/characters/save</code>，
              将精确写入你勾选的 {selectedCount} 个预览角色到 ecjoy 数据库（重名跳过）。
            </div>
          )}
        </>
      )}
    </div>
  );
}
