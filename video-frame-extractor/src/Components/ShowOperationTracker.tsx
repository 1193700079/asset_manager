import { useEffect, useRef } from "react";
import ImageButton from "./ImageButton";
import { lang } from "../Scripts/Translations";

interface Props {
    /**
     * The function called to close the dialog
     */
    close: () => void
}

/**
 * Shows a fullscreen alert that tells the user where they can track the extraction progress
 * @returns the ShowOperationTracker ReactNode
 */
export default function ShowOperationTracker({close}: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useEffect(() => {
        window.scrollTo({top: 0, behavior: "smooth"}); // The item is in the top-right corner, so to see it we need to scroll above.
        setTimeout(() => {if (dialog.current) dialog.current.style.opacity = "1"}, 25); // Show the dialog
        document.body.style.setProperty("--documentqueueborder", "10px solid var(--accent)"); // Add a border to the button so that it's more visible
    }, []);
    /**
     * If true, this won't be shown again
     */
    const avoidShowingThis = useRef(false);
    return <div ref={dialog} className="dialog" style={{zIndex: "1"}}>
        <div>
            <div style={{position: "fixed", top: "60px", flexDirection: "column", width: "80vw", left: "10vw"}} className="flex wcenter">
                <h2>{lang("The frame extraction has started!")}</h2>
                <p>{lang(`Click on the "Document queue" icon at the top right of the screen to track the progress.`)}</p><br></br>
                <i style={{marginBottom: "20px"}}>{lang("If you aren't seeing it now, the conversion has already ended. In this case, close this dialog.")}</i>
                <label style={{marginBottom: "20px"}} className="flex hcenter gap">
                    <input type="checkbox" onChange={(e) => (avoidShowingThis.current = e.target.checked)}></input>
                    {lang("Don't show this again")}
                </label><br></br>
                <ImageButton img="checkmark" onClick={async () => { // Close the dialog
                    localStorage.setItem("VideoFrameExtractor-ShowDocumentQueue", avoidShowingThis.current ? "a" : "b");
                    document.body.style.setProperty("--documentqueueborder", "0px"); // Delete the border
                    if (dialog.current) {
                        dialog.current.style.opacity = "0";
                        await new Promise(res => setTimeout(res, 210));
                    }
                    close();
                }}>{lang("Got it")}</ImageButton>
            </div>
        </div>
    </div>
}