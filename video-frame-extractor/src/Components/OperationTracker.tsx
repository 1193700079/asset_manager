import { useEffect, useRef, useState } from "react"
import type { QueueProp } from "../Scripts/Interface"
import GetIcons from "../Scripts/Icons";
import Card from "./Card";
import ImageButton from "./ImageButton";
import { lang } from "../Scripts/Translations";

interface Props {
    status: QueueProp[],
}

/**
 * A button in the top-right corner that permits to access to the extractions that are being run.
 * It's shown only if there is at least one ongoing operation.
 * 
 * If clicked, a Dialog it's shown where each operation has a description and a progress bar
 * @returns the OperationTracker ReactNode
 */
export default function OperationTracker({ status }: Props) {
    const [isTrackerOpen, openTracker] = useState(false);
    /**
     * The button that opens the dialog
     */
    const buttonRef = useRef<HTMLDivElement>(null);
    /**
     * The dialog
     */
    const dialogRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (buttonRef.current) buttonRef.current.style.opacity = status.length === 0 ? "0" : "1"; // Hide the button if there are no ongoing conversoins
    }, [status]);
    useEffect(() => {
        if (dialogRef.current) setTimeout(() => {if (dialogRef.current && isTrackerOpen) dialogRef.current.style.opacity = "1"} ); // Show the dialog
    }, [isTrackerOpen])
    // status.length === 0 ? <></> : !isTrackerOpen ? 
    return <>
        <div key={"DocumentQueueButton"} ref={buttonRef} data-operationtracker onClick={() => buttonRef.current?.style.opacity !== "0" && openTracker(true)} className="card pointer opacity buttonLike" style={{ width: "24px", height: "24px", borderRadius: "50%", position: "absolute", top: "15px", right: "15px", zIndex: "2", border: "var(--documentqueueborder)" }}>
            <img style={{ width: "100%", height: "100%" }} ref={ref => GetIcons({ ref, type: "queue" })}></img>
        </div>
        {isTrackerOpen && <div className="dialog" ref={dialogRef}>
            <Card>
                <div style={{height: "100%", overflow: "auto"}}>
                    <h2>{lang("Export progress:")}</h2>
                    {status.map(item => <div key={`ExportTracker-${item.id}`}><Card secondLevel={true}>
                        <p>{item.description}</p>
                        <i>{lang("Exporting frame")} {item.progress} {lang("of")} {item.max}</i><br></br><br></br>
                        <progress value={item.progress} max={item.max}></progress>
                    </Card><br></br></div>)}<br></br>
                    <ImageButton img="dismiss" onClick={async () => { // Close the dialog
                        if (dialogRef.current) {
                            dialogRef.current.style.opacity = "0";
                            await new Promise(res => setTimeout(res, 210));
                        }
                        openTracker(false);
                    }}>{lang("Close")}</ImageButton>
                </div>
            </Card>
            </div>}
    </>
}