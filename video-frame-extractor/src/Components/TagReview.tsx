import { useEffect, useState } from "react";

interface PendingTag {
    id: string;
    tag: string;
    dimension: string;
    videoPath: string;
    createdAt: string;
    status: string;
}

interface TagReviewProps {
    onBack: () => void;
}

export default function TagReview({ onBack }: TagReviewProps) {
    const [grouped, setGrouped] = useState<Record<string, PendingTag[]>>({});
    const [total, setTotal] = useState(0);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);

    async function fetchPending() {
        try {
            const res = await fetch("/api/tags/pending");
            const data = await res.json();
            if (data.success) {
                setGrouped(data.data || {});
                setTotal(data.total || 0);
            }
        } catch (err) {
            console.error("Failed to fetch pending tags:", err);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        fetchPending();
    }, []);

    function toggleSelect(id: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function selectAllInDimension(dim: string) {
        const ids = (grouped[dim] || []).map((t) => t.id);
        setSelected((prev) => {
            const next = new Set(prev);
            const allSelected = ids.every((id) => next.has(id));
            if (allSelected) {
                ids.forEach((id) => next.delete(id));
            } else {
                ids.forEach((id) => next.add(id));
            }
            return next;
        });
    }

    function selectAll() {
        const allIds = Object.values(grouped)
            .flat()
            .map((t) => t.id);
        setSelected((prev) => {
            const allSelected = allIds.every((id) => prev.has(id));
            return allSelected ? new Set() : new Set(allIds);
        });
    }

    async function handleApprove(ids?: string[]) {
        const targetIds = ids || Array.from(selected);
        if (targetIds.length === 0) return;
        try {
            const res = await fetch("/api/tags/approve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: targetIds }),
            });
            const data = await res.json();
            if (data.success) {
                setSelected(new Set());
                await fetchPending();
            }
        } catch (err) {
            console.error("Approve failed:", err);
        }
    }

    async function handleReject(ids?: string[]) {
        const targetIds = ids || Array.from(selected);
        if (targetIds.length === 0) return;
        try {
            const res = await fetch("/api/tags/reject", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: targetIds }),
            });
            const data = await res.json();
            if (data.success) {
                setSelected(new Set());
                await fetchPending();
            }
        } catch (err) {
            console.error("Reject failed:", err);
        }
    }

    const dimensions = Object.keys(grouped).sort();

    if (loading) {
        return (
            <div className="tag-review">
                <div className="tag-review-header">
                    <button className="tag-review-back" onClick={onBack}>
                        ← 返回视频列表
                    </button>
                    <h2>待审核标签</h2>
                </div>
                <p style={{ textAlign: "center", padding: "2rem" }}>加载中...</p>
            </div>
        );
    }

    return (
        <div className="tag-review">
            <div className="tag-review-header">
                <button className="tag-review-back" onClick={onBack}>
                    ← 返回视频列表
                </button>
                <h2>待审核标签 ({total})</h2>
                {total > 0 && (
                    <div className="tag-review-global-actions">
                        <button className="tag-review-btn select" onClick={selectAll}>
                            {Object.values(grouped)
                                .flat()
                                .every((t) => selected.has(t.id))
                                ? "取消全选"
                                : "全选"}
                        </button>
                        <button
                            className="tag-review-btn approve"
                            onClick={() => handleApprove()}
                            disabled={selected.size === 0}
                        >
                            ✓ 批量确认 ({selected.size})
                        </button>
                        <button
                            className="tag-review-btn reject"
                            onClick={() => handleReject()}
                            disabled={selected.size === 0}
                        >
                            ✗ 批量拒绝 ({selected.size})
                        </button>
                    </div>
                )}
            </div>

            {total === 0 ? (
                <div className="tag-review-empty">
                    <p>暂无待审核标签</p>
                    <p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
                        当 AI 标注返回包含 [NEW] 前缀的新标签时，会出现在这里等待审核
                    </p>
                </div>
            ) : (
                <div className="tag-review-dimensions">
                    {dimensions.map((dim) => {
                        const tags = grouped[dim];
                        const dimSelected = tags.filter((t) => selected.has(t.id));
                        const allDimSelected =
                            tags.length > 0 && tags.every((t) => selected.has(t.id));

                        return (
                            <div key={dim} className="tag-review-dimension">
                                <div className="tag-review-dim-header">
                                    <h3>
                                        {dim.replace(".md", "")} ({tags.length})
                                    </h3>
                                    <div className="tag-review-dim-actions">
                                        <button
                                            className="tag-review-btn-sm select"
                                            onClick={() => selectAllInDimension(dim)}
                                        >
                                            {allDimSelected ? "取消" : "全选"}
                                        </button>
                                        <button
                                            className="tag-review-btn-sm approve"
                                            onClick={() =>
                                                handleApprove(dimSelected.map((t) => t.id))
                                            }
                                            disabled={dimSelected.length === 0}
                                        >
                                            ✓ 确认 ({dimSelected.length})
                                        </button>
                                        <button
                                            className="tag-review-btn-sm reject"
                                            onClick={() =>
                                                handleReject(dimSelected.map((t) => t.id))
                                            }
                                            disabled={dimSelected.length === 0}
                                        >
                                            ✗ 拒绝 ({dimSelected.length})
                                        </button>
                                    </div>
                                </div>
                                <div className="tag-review-tags">
                                    {tags.map((tag) => (
                                        <label key={tag.id} className="tag-review-tag-row">
                                            <input
                                                type="checkbox"
                                                checked={selected.has(tag.id)}
                                                onChange={() => toggleSelect(tag.id)}
                                            />
                                            <span className="tag-review-tag-text">{tag.tag}</span>
                                            <span className="tag-review-tag-meta">
                                                {tag.videoPath
                                                    ? tag.videoPath.split("/").pop()
                                                    : "unknown"}
                                            </span>
                                            <span className="tag-review-tag-time">
                                                {new Date(tag.createdAt).toLocaleDateString()}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function PendingTagsBadge({
    onClick,
}: {
    onClick: () => void;
}) {
    const [count, setCount] = useState(0);

    useEffect(() => {
        fetch("/api/tags/pending")
            .then((r) => r.json())
            .then((d) => {
                if (d.success) setCount(d.total || 0);
            })
            .catch(() => { });
    }, []);

    if (count === 0) return null;

    return (
        <button className="pending-tags-badge" onClick={onClick}>
            待审核标签 <span className="badge-count">{count}</span>
        </button>
    );
}
