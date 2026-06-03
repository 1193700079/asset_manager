import GetIcons from "../Scripts/Icons";
import { lang } from "../Scripts/Translations";

interface Props {
    /**
     * The function that is called when the user wants to choose another video.
     * This is triggered when the user clicks on the icon.
     */
    restoreEverything: () => void
}
/**
 * The title of the webpage
 * @returns the header ReactNode
 */
export default function Header({restoreEverything}: Props) {
    return <header>
        <div className="flex hcenter gap">
            <img className="pointer" onClick={() => confirm("Do you want to choose another video file? All changes done will be discarded.") && restoreEverything()} data-icon width={48} height={48} ref={ref => GetIcons({
                ref,
                type: "filmstrip",
                colorId: "--accent"
            })}></img>
        <h1>Video Frame Extractor</h1>
        </div>
        <p>{lang("Extract one (or multiple) frames from your videos, and download them.")}</p>
    </header>
}