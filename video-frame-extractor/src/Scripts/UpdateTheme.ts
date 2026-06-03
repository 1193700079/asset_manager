import GetIcons, { iconsMap } from "./Icons";

/**
 * Apply the application theme everywhere in the website
 */
export default function UpdateTheme() {
    for (const [img, val] of iconsMap) { // Update every icon to the new colors
        if (img) {
            GetIcons({
                ref: img,
                type: val.iconId,
                colorId: val.propertyValue,
                addToList: false
            });
        }
    }
    // Update the custom select style so that the custom arrow has the same color as of the text.
    let getSelect = (document.getElementById("customSelectColor") as HTMLStyleElement);
    let startSelect = getSelect.innerHTML.lastIndexOf("fill=") + 6;
    getSelect.innerHTML = `${getSelect.innerHTML.substring(0, startSelect)}${encodeURIComponent(getComputedStyle(document.body).getPropertyValue("--text"))}${getSelect.innerHTML.substring(getSelect.innerHTML.indexOf("'", startSelect))}`;
}