import type { MouseEventHandler, ReactNode } from "react";
import type { iconsStore } from "../Scripts/Icons";
import GetIcons from "../Scripts/Icons";

interface Props {
    /**
     * The icon id
     */
    img: keyof typeof iconsStore,
    /**
     * The text that'll be at the right of the ReacctNode
     */
    children: ReactNode,
    /**
     * The event that'll be triggered when the user clicks the button
     */
    onClick: MouseEventHandler<HTMLButtonElement>,
    /**
     * If the button should be disabled or not
     */
    disabled?: boolean
}

/**
 * A button with an image at its left
 * @returns the ImageButton ReactNode
 */
export default function ImageButton({ img, children, onClick, disabled }: Props) {
    return <button disabled={disabled} className="flex hcenter gap wcenter" onClick={onClick}>
        <img ref={ref => GetIcons({
            ref,
            type: img
        })} style={{ width: "24px", height: "24px" }}></img>
        {children}
    </button>

}