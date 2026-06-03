import { createRoot } from "react-dom/client";
import Alert from "../Components/Alert";
import { createPortal } from "react-dom";

const availableTranslations = ["it"];

interface TranslationItems {
    it: string
}
const translationStrings = new Map<string, TranslationItems>([
    ["Open a file", { it: "Apri un file" }],
    ["Click on the button below to open a video file. Don't worry, everything will be elaborated locally and nothing will be sent to a server.", {it: "Clicca sul pulsante qui in basso per aprire un file video. Non preoccuparti, tutto sarà elaborato localmente e niente verrà inviato ad un server."}],
    ["Pick file", {it: "Scegli file"}],
    ["Settings", {it: "Impostazioni"}],
    ["View on GitHub", {it: "Visualizza su GitHub"}],
    ["Extract one (or multiple) frames from your videos, and download them.", {it: "Estrai uno (o più) frame dai tuoi video, e salvali."}],
    ["Analyzing video framerate", {it: "Analizzo il framerate del video"}],
    ["Do not switch tabs. This should take approximately three seconds.", {it: "Non cambiare scheda. Questo dovrebbe richiedere circa tre secondi."}],
    ["Video preview:", {it: "Anteprima del video:"}],
    ["Previous frame", {it: "Frame precedente"}],
    ["Play", {it: "Riproduci"}],
    ["Pause", {it: "Pausa"}],
    ["Next frame", {it: "Prossimo frame"}],
    ["Export frame:", {it: "Esporta frame:"}],
    ["Export single frame", {it: "Esporta il singolo frame"}],
    ["Export frame interval", {it: "Esporta un intervallo di frame"}],
    ["Export current frame", {it: "Esporta il frame corrente"}],
    ["Add current frame to export list", {it: "Aggiungi il frame corrente alla lista delle esportazioni"}],
    ["Download all frames", {it: "Scarica tutti i frame"}],
    ["From", {it: "Da"}],
    ["seconds", {it: "secondi"}],
    ["To", {it: "a"}],
    ["Update the video position while changing from/to seconds", {it: "Aggiorna la posizione del video quando i secondi di inizio/fine vengono cambiati"}],
    ["Export frames", {it: "Esporta frame"}],
    ["Export options:", {it: "Opzioni di esportazione:"}],
    ["Output format:", {it: "Formato di destinazione:"}],
    ["Image quality (irrelevant for PNG files):", {it: "Qualità dell'immagine (irrilevante per i file PNG)"}],
    ["Change theme:", {it: "Cambia tema:"}],
    ["You can choose one of the two default themes, or to create your own one.", {it: "Puoi scegliere uno dei due temi di default, oppure puoi crearne uno tuo."}],
    ["Click here to restore default themes", {it: "Clicca qui per ripristinare i temi di default"}],
    ["Dark theme", {it: "Tema scuro"}],
    ["Light theme", {it: "Tema chiaro"}],
    ["Save and close", {it: "Salva e chiudi"}],
    ["Certain elements, like the color of the icons and the arrow next each dropdown menu (both tied to the \"Text\" value), will be changed only after saving the theme.", {it: "Alcuni elementi, come il colore delle icone e la freccia di fianco ogni menù a discesa (entrambe legate al campo \"Text\"), saranno cambiate solo dopo aver salvato il tema."}],
    ["View frames list", {it: "Visualizza lista dei frame"}],
    ["Frames list:", {it: "Lista dei frame"}],
    ["Download everything", {it: "Scarica tutto"}],
    ["Download settings:", {it: "Impostazioni del download:"}],
    ["Remove images from list after download", {it: "Rimuovi immagini dalla lista dopo il download"}],
    ["Download list", {it: "Scarica lista"}],
    ["Click on an image to delete it, on its file name to download it or on its timestamp to go to that frame.", {it: "Clicca su un'immagine per eliminarla, o sul suo nome per sacricarla, o sul suo timestamp per andare a quel frame."}],
    ["Image:", {it: "Immagine:"}],
    ["File name:", {it: "Nome del file:"}],
    ["Timestamp:", {it: "Timestamp"}],
    ["Save in a zip file", {it: "Salva in un file zip"}],
    ["Try using less memory when creating the zip file. Disable this if you're facing download issues.", {it: "Prova ad usare minore memoria quando viene creato il file zip. Disabilita se stai riscontrando problemi nel download."}],
    ["Share current frame", {it: "Condividi il frame corrente"}],
    ["Save each image individually", {it: "Salva ogni immagine individualmente"}],
    ["Share images", {it: "Condividi immagini"}],
    ["Open source licenses:", {it: "Licenze open source:"}],
    ["Resize the output image", {it: "Ridimensiona l'immagine di destinazione"}],
    ["Resize options:", {it: "Impostazioni di ridimensionamento:"}],
    ["Resize in percentage", {it: "Ridimensiona in percentuale"}],
    ["Set a fixed width", {it: "Imposta una larghezza fissa"}],
    ["Set a fixed height", {it: "Imposta un'altezza fissa"}],
    ["Output image width/height:", {it: "Larghezza/altezza dell'immagine di destinazione:"}],
    ["Output width", {it: "Larghezza di destinazione"}],
    ["Output height", {it: "Altezza di destinazione"}],
    ["Export progress:", {it: "Progresso delle esportazioni:"}],
    ["Exporting frame", {it: "Esportando frame"}],
    ["of", {it: "di"}],
    ["Close", {it: "Chiudi"}],
    ["Create a new video element for this operation. This will allow you to download multiple intervals at the same time, but it will increment RAM usage.", {it: "Crea un nuovo elemento video per quest'operazione. Questo ti permette di scaricare più intervalli allo stesso tempo, ma può aumentare l'utilizzo della RAM."}],
    ["Extracting frame interval between", {it: "Estraendo l'intervallo di frame tra"}],
    ["and", {it: "e"}],
    ["Downloaded", {it: "Scaricato"}],
    ["We tried to share the files.", {it: "Abbiamo provato a condividere i file."}],
    ["Share again", {it: "Condividi ancora"}],
    ["Force download", {it: "Forza download"}],
    ["The frame extraction has started!", {it: "L'estrazione dei frame è cominciata!"}],
    [`Click on the "Document queue" icon at the top right of the screen to track the progress.`, {it: `Clicca sull'icona della coda dei documenti in alto a destra per monitorare il progresso.`}],
    ["If you aren't seeing it now, the conversion has already ended. In this case, close this dialog.", {it: "Se non la vedi, vuol dire che la conversione è già finita. Chiudi questo dialog."}],
    ["Don't show this again", {it: "Non mostrarlo ancora"}],
    ["Got it", {it: "Capito"}],
    ["Advanced settings:", {it: "Impostazioni avanzate"}],
    ["Version", {it: "Versione"}],
    ["Downloading frame list", {it: "Scarico la lista dei frame"}]
])

/**
 * If the translation has been applied using the browser's language
 */
export let usedBrowserLang = false;

/**
 * Translate a string to the selected language. If no language has been selected, the `navigator.language` property will be used (obviously if a translation is available in that language)
 * @param str the string to translate
 * @returns the translated string
 */
export function lang(str: string) {
    const suggestedLanguage = localStorage.getItem("VideoFrameExtractor-Language");
    if (suggestedLanguage) {
        if (availableTranslations.indexOf(suggestedLanguage) !== -1) {
            const a = translationStrings.get(str);
            if (a) return a[suggestedLanguage as "it"] ?? str;
        }
        return str;
    } 
    const browserLang = navigator.language.substring(0,2);
    if (availableTranslations.indexOf(browserLang) !== -1) {
        usedBrowserLang = true;
        const a = translationStrings.get(str);
        if (a) return a[browserLang as "it"] ?? str;
    }
    return str;
}