import type { ReactNode } from "react"

interface Props {
    /**
     * The content inside the card
     */
    children: ReactNode,
    /**
     * If the card should be inside another card. This means a lighter color in dark mode and a darker color in light mode.
     */
    secondLevel?: boolean,
    /**
     * If the div should have "width: 100%"
     */
    fullWidth?: boolean
}
/**
 * A div with a different color, to differentiate the content in it
 * @returns the Card ReactNode
 */
export default function Card({children, secondLevel, fullWidth}: Props) {
    return <div className={`card${fullWidth ? " fullWidth" : ""}`} style={{backgroundColor: secondLevel ? "var(--secondcard)" : undefined}}>
        {children}
    </div>
}