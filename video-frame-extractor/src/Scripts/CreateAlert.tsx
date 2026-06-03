import { useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Alert from "../Components/Alert";
import { lang } from "./Translations";

/**
 * Create a new alert in the top of the screen
 * @param item the ReactNode of the item to add at the left of the Alert icon
 * @param elements a list of HTMLElements to add in the Alert
 * @returns the function to close the Alert
 */
export default function CreateAlert(item: ReactNode, ...elements: HTMLElement[]) {
    const div = document.createElement("div");
    function closeDiv() {
        (div.querySelector(".opacity") as HTMLElement).style.opacity = "0";
        setTimeout(() => { root.unmount(); div.remove() }, 210);
    }
    const root = createRoot(div);
    root.render(<Alert askForDismiss={closeDiv}>
        {item}
    </Alert>);
    document.body.append(div);
    setTimeout(() => {
        (div.querySelector(".opacity") as HTMLElement).style.opacity = "1";
        for (const item of elements) div.firstElementChild?.insertBefore(item, div.firstElementChild.lastChild ?? null);
    }, 50);
    setTimeout(closeDiv, 50050);
    return closeDiv;
}