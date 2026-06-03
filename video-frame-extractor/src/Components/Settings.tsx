import { useEffect, useRef, useState } from "react";
import Card from "./Card";
import UpdateTheme from "../Scripts/UpdateTheme";
import ImageButton from "./ImageButton";
import { lang } from "../Scripts/Translations";
import { getOpenSourceStr, OpenSourceMap } from "../Scripts/OpenSource";
import type { OpenSourceLicense } from "../Scripts/Interface";
import CreateAlert from "../Scripts/CreateAlert";

/**
 * Change the language; customize the appearance and read the open source licenses.
 * 
 * This ReactNode consists of a label added in the bottom of the UI, that, if clicked, shows the Dialog.
 * @returns the Settings ReactNode
 */
export default function Settings() {
    const [showSettings, updateShowSettings] = useState(false);
    /**
     * A list of the CSS attributes to edit
     */
    const availableCustomElements = ["background", "text", "card", "secondcard", "accent"];
    /**
     * The settings dialog
     */
    const dialog = useRef<HTMLDivElement>(null);
    const [forceRerender, updateForceRerender] = useState(0);
    /**
     * Save the custom theme in the LocalStorage
     */
    function saveNewTheme() {
        let obj: any = {};
        for (const key of availableCustomElements) obj[key] = getComputedStyle(document.body).getPropertyValue(`--${key}`);
        localStorage.setItem("VideoFrameExtractor-Theme", JSON.stringify(obj));
        UpdateTheme();
    }
    useEffect(() => {
        if (showSettings && dialog.current) setTimeout(() => { (dialog.current as HTMLElement).style.opacity = "1" }, 15); // Show the dialog
    }, [showSettings]);

    const [chosenLicense, updateChosenLicense] = useState<OpenSourceLicense>(OpenSourceMap.get("videoFrameExtractor") as OpenSourceLicense);
    return <>
        <span style={{ textDecoration: "underline" }} className="pointer" onClick={() => {
            updateShowSettings(true);
        }}>{lang("Settings")}</span>

        {showSettings && <div className="dialog" ref={dialog}>
            <Card>
                <div style={{ overflow: "auto", height: "100%" }}>
                    <h2>{lang("Settings")}:</h2>
                    <ImageButton img="save" onClick={async () => {
                        saveNewTheme();
                        if (dialog.current) {
                            dialog.current.style.opacity = "0";
                            await new Promise(res => setTimeout(res, 210));
                        }
                        updateShowSettings(false);
                    }}>{lang("Save and close")}</ImageButton><br></br>

                    <Card secondLevel={true}>
                        <h3>Language:</h3>
                        <select defaultValue={localStorage.getItem("VideoFrameExtractor-Language") ?? navigator.language.substring(0, 2)} onChange={(e) => {
                            localStorage.setItem("VideoFrameExtractor-Language", e.target.value);
                            CreateAlert(<span>This setting will be gradually applied. You can force it now by refreshing the webpage.</span>)
                        }}>
                            <option value={"en"}>English</option>
                            <option value={"it"}>Italiano</option>
                        </select>
                    </Card><br></br>
                    <Card secondLevel={true}>
                        <div style={{ overflow: "auto" }}>
                            <h3>{lang("Change theme:")}</h3>
                            <p>{lang("You can choose one of the two default themes, or to create your own one.")}</p>
                            <select defaultValue={"no"} onChange={(e) => {
                                for (const key of availableCustomElements) document.body.style.setProperty(`--${key}`, `var(--${key}-${e.target.value === "light" ? "light" : "dark"})`);
                                updateForceRerender(i => i + 1);
                            }}>
                                <option disabled value={"no"}>{lang("Click here to restore default themes")}</option>
                                <option value={"dark"}>{lang("Dark theme")}</option>
                                <option value={"light"}>{lang("Light theme")}</option>
                            </select><br></br><br></br>
                            <div className="flex gap" style={{ flexWrap: "wrap" }} key={`CustomThemeContainer-${forceRerender}`}>
                                {availableCustomElements.map((item, i) =>
                                    <Card>
                                        <label className="flex hcenter gap">
                                            <input style={{ height: "35px", width: "70px", padding: "5px" }} type="color" defaultValue={getComputedStyle(document.body).getPropertyValue(`--${item}`)} onChange={(e) => {
                                                document.body.style.setProperty(`--${item}`, e.target.value);
                                            }}></input>
                                            {`${item[0].toUpperCase()}${item.substring(1)}`}
                                        </label>
                                    </Card>)}
                            </div><br></br>
                            <p>{lang("Certain elements, like the color of the icons and the arrow next each dropdown menu (both tied to the \"Text\" value), will be changed only after saving the theme.")}</p>
                        </div>
                    </Card><br></br>
                    <Card secondLevel={true}>
                        <h3>{lang("Open source licenses:")}</h3>
                        <select onChange={e => updateChosenLicense(OpenSourceMap.get(e.target.value) as OpenSourceLicense)}>
                            <option value={"videoFrameExtractor"}>Video Frame Extractor</option>
                            <option value={"fluent"}>Fluent UI System Icons</option>
                            <option value={"react"}>React</option>
                            <option value={"zip.js"}>Zip.JS</option>
                            <option value={"vite"}>Vite</option>
                        </select><br></br><br></br>
                        <Card>
                            <p style={{whiteSpace: "pre-line"}}>
                                {getOpenSourceStr(chosenLicense.type, chosenLicense.author)}
                            </p>
                        </Card>
                    </Card>
                </div>
            </Card>
        </div>}
    </>
}