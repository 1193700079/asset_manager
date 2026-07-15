import { useState } from 'react';
import type { CategoryCount } from '../types';
import { api } from '../api/client';
import './CharacterCreate.css';

interface Props {
  categories: CategoryCount[];
  onBack: () => void;
  onCreated: (name: string) => void;
}

interface AttrRow { key: string; value: string; }

export default function CharacterCreate({ categories, onBack, onCreated }: Props) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [description, setDescription] = useState('');
  const [attrs, setAttrs] = useState<AttrRow[]>([{ key: '', value: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const usingNewCat = category === '__new__';
  const resolvedCategory = (usingNewCat ? newCategory.trim() : category.trim()) || undefined;
  const canSave = !!name.trim() && !saving;

  const setAttr = (i: number, patch: Partial<AttrRow>) =>
    setAttrs(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addAttr = () => setAttrs(rows => [...rows, { key: '', value: '' }]);
  const removeAttr = (i: number) => setAttrs(rows => rows.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    if (!name.trim()) return;
    setError('');
    setSaving(true);
    try {
      const attributes: Record<string, string> = {};
      for (const { key, value } of attrs) {
        const k = key.trim();
        if (k) attributes[k] = value.trim();
      }
      const res = await api.createCharacter({
        name: name.trim(),
        category: resolvedCategory,
        description: description.trim() || undefined,
        attributes: Object.keys(attributes).length ? attributes : undefined,
      });
      if (res.id == null) {
        setError('角色已存在或创建失败（名称冲突）。');
        setSaving(false);
        return;
      }
      onCreated(name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
      setSaving(false);
    }
  };

  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="cc-page">
      <div className="cc-main">
        {/* Left column: live preview */}
        <div className="cc-aside">
          <div className="cc-preview-card">
            <div className="cc-preview-avatar">{initial}</div>
            <div className="cc-preview-name">{name.trim() || '未命名角色'}</div>
            <div className="cc-preview-cat">{resolvedCategory || 'uncategorized'}</div>
          </div>
          <p className="cc-aside-hint">
            创建后可在角色详情页继续上传头像、指派语音、生成图片与视频。
          </p>
        </div>

        {/* Right column: form */}
        <div className="cc-form">
          <section className="cc-section">
            <h2 className="cc-section-title">基本信息 / Basic Info</h2>
            <label className="cc-field">
              <span className="cc-label">名称 <span className="cc-req">*</span></span>
              <input
                className="cc-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="角色名称"
                autoFocus
              />
            </label>
            <label className="cc-field">
              <span className="cc-label">分类 / Category</span>
              <select className="cc-input" value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">uncategorized</option>
                {categories.map(c => (
                  <option key={c.category} value={c.category}>{c.category} ({c.count})</option>
                ))}
                <option value="__new__">+ 新建分类…</option>
              </select>
            </label>
            {usingNewCat && (
              <label className="cc-field">
                <span className="cc-label">新分类名</span>
                <input
                  className="cc-input"
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  placeholder="输入新分类"
                />
              </label>
            )}
            <label className="cc-field">
              <span className="cc-label">描述 / Description</span>
              <textarea
                className="cc-input cc-textarea"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="可选描述"
                rows={4}
              />
            </label>
          </section>

          <section className="cc-section">
            <h2 className="cc-section-title">属性 / Attributes</h2>
            <p className="cc-section-hint">自由键值对（如 Age / Height / Personality），会随角色保存。</p>
            <div className="cc-attrs">
              {attrs.map((row, i) => (
                <div className="cc-attr-row" key={i}>
                  <input
                    className="cc-input cc-attr-key"
                    value={row.key}
                    onChange={e => setAttr(i, { key: e.target.value })}
                    placeholder="键 (Key)"
                  />
                  <input
                    className="cc-input cc-attr-val"
                    value={row.value}
                    onChange={e => setAttr(i, { value: e.target.value })}
                    placeholder="值 (Value)"
                  />
                  <button
                    className="cc-attr-del"
                    onClick={() => removeAttr(i)}
                    disabled={attrs.length === 1}
                    title="删除此行"
                  >×</button>
                </div>
              ))}
            </div>
            <button className="cv-pi-button cv-pi-button--compact cc-add-attr" onClick={addAttr}>
              + 添加属性
            </button>
          </section>

          {error && <div className="cc-error">{error}</div>}
        </div>
      </div>

      {/* Sticky bottom action bar */}
      <div className="cc-actionbar">
        <div className="cc-actionbar-inner">
          <button className="cv-pi-button" onClick={onBack}>取消 / Cancel</button>
          <button
            className="cv-pi-button cv-pi-button--primary"
            onClick={handleSave}
            disabled={!canSave}
          >
            {saving ? '创建中…' : '创建角色 / Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
