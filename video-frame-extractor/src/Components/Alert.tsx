import type { ReactNode } from "react";
import GetIcons from "../Scripts/Icons";

interface Props {
    /**
     * The content in the ReactNode
     */
    children: ReactNode,
    /**
     * The function to call when the alert should be closed
     */
    askForDismiss: () => void
}

/**
 * Show an alert in the top of the screen
 * @returns the ReactNode of the alert
 */
export default function Alert({children, askForDismiss}: Props) {
    return <div className="alert flex hcenter wcenter gap opacity" style={{opacity: "0"}}>
        <img ref={ref => GetIcons({
            ref,
            type: "alert"
        })}></img>
        <div>
            {children}
        </div>
        <img className="pointer" onClick={askForDismiss} ref={ref => GetIcons({
            ref,
            type: "dismiss"
        })}></img>
    </div>
}