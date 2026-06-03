import { useEffect, useRef, useState, type ReactNode } from "react";
import { lang } from "../Scripts/Translations";
import Card from "./Card";


interface Props {
    /**
     * The function called when the user changes one of the two default options
     * @param value the object of the changed properties
     */
    callback: (value: { downloadType: "link" | "zip" | "share", useServiceWorker: boolean }) => void,
    /**
     * If the controls should be disabled
     */
    disabled?: boolean,
    /**
     * Add other advanced options, that aren't tied to the zip file.
     */
    otherAdvancedOptions?: ReactNode
}
/**
 * The ReactNode that contains the settings for the download. 
 * It permits to choose to share the files, to add them in a zip file or to download them as a link, and, in case the zip file option is chosen, to download them using a Service Worker
 * @returns the ZipOptionsCallback ReactNode
 */
export default function ZipOptionsCallback({ callback, disabled, otherAdvancedOptions }: Props) {
    const [options, updateOptions] = useState({
        downloadType: "zip" as "zip",
        useServiceWorker: !!navigator.serviceWorker?.controller
    });
    useEffect(() => {
        callback(options);
    }, [options])
    return <>
        <select disabled={disabled} defaultValue={options.downloadType} onChange={(e) => (updateOptions(prev => { return { ...prev, downloadType: e.target.value as "zip" } }))}>
            <option value={"zip"}>{lang("Save in a zip file")}</option>
            <option value={"link"}>{lang("Save each image individually")}</option>
            <option value={"share"}>{lang("Share images")}</option>
        </select>
        <br></br><br></br>
        {(otherAdvancedOptions || options.downloadType === "zip") && <>
            <Card>
                <details>
                <summary><h4 style={{display: "inline", marginLeft: "5px"}}>{lang("Advanced settings:")}</h4></summary><br></br>
                    {options.downloadType === "zip" && <label className="flex hcenter gap">
                        <input disabled={disabled} type="checkbox" defaultChecked={options.useServiceWorker} onChange={(e) => updateOptions(prev => { return { ...prev, useServiceWorker: e.target.checked } })}></input>
                        {lang("Try using less memory when creating the zip file. Disable this if you're facing download issues.")}
                    </label>}
                    {options.downloadType === "zip" && otherAdvancedOptions && <br></br>}
                    {otherAdvancedOptions}
                </details>
            </Card>
        </>}

    </>
}