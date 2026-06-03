import "./VideoNav.css";

interface Props {
    /** Index of currently displayed video within the filtered list (0-based). */
    currentIndex: number;
    /** Total count of videos in the filtered list. */
    total: number;
    /** Display name of the currently selected video. */
    currentName?: string;
    /** Return to the dossier (VideoBrowser). */
    onReturn: () => void;
    /** Switch to the previous video. No confirm dialog. */
    onPrev: () => void;
    /** Switch to the next video. No confirm dialog. */
    onNext: () => void;
    /** Which tab the user came from (for contextual back label). */
    sourceTab?: string;
}

/**
 * Navigation rail rendered above MainVideoUI when a video is open.
 * Provides one-click traversal of the filtered VideoBrowser list and
 * a fast escape hatch back to the dossier — without confirm prompts.
 */
export default function VideoNav({ currentIndex, total, currentName, onReturn, onPrev, onNext, sourceTab }: Props) {
    const hasIndex = total > 0 && currentIndex >= 0;
    const human = hasIndex ? currentIndex + 1 : 0;
    const padWidth = Math.max(3, String(total).length);
    const currentLabel = hasIndex ? String(human).padStart(padWidth, "0") : "—";
    const totalLabel = total > 0 ? String(total).padStart(padWidth, "0") : "—";

    const prevDisabled = !hasIndex || currentIndex <= 0;
    const nextDisabled = !hasIndex || currentIndex >= total - 1;

    return (
        <nav className="vn-rail" aria-label="Video navigation">
            <button
                type="button"
                className="vn-back"
                onClick={onReturn}
                title="Return to the dossier (Esc)"
            >
                <span className="vn-back-arrow" aria-hidden="true">↩</span>
                <span>
                    <span className="vn-back-eyebrow">Archive</span>
                    <span className="vn-back-label">
                        {sourceTab === "annotated" ? "← 已标注列表" : sourceTab === "skipped" ? "← 已跳过列表" : "Return to list"}
                    </span>
                </span>
            </button>

            {hasIndex && (
                <div className="vn-center">
                    <button
                        type="button"
                        className="vn-arrow vn-prev"
                        onClick={onPrev}
                        disabled={prevDisabled}
                        title="Previous video"
                        aria-label="Previous video"
                    >
                        ‹
                    </button>

                    <div className="vn-index" role="status" aria-live="polite">
                        <span>
                            <span className="vn-index-current">{currentLabel}</span>
                            <span className="vn-index-sep"> / </span>
                            <span className="vn-index-total">{totalLabel}</span>
                            <span className="vn-index-tag">position</span>
                        </span>
                    </div>

                    <button
                        type="button"
                        className="vn-arrow vn-next"
                        onClick={onNext}
                        disabled={nextDisabled}
                        title="Next video"
                        aria-label="Next video"
                    >
                        ›
                    </button>
                </div>
            )}

            <div className="vn-slug" title={currentName ?? ""}>
                <span className="vn-slug-eyebrow">now reading</span>
                <span className="vn-slug-name">{currentName ?? "—"}</span>
            </div>
        </nav>
    );
}
