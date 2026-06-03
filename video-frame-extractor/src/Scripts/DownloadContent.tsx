import type { ZipWriter, ZipWriterStream } from "@zip.js/zip.js";
import CreateAlert from "./CreateAlert";
import { lang } from "./Translations";

/**
 * The type of the zip file
 */
type DownloadType<T> = T extends "zipblob" ? ZipWriter<Blob> : T extends "zipstream" ? ZipWriterStream : T extends "share" ? File[] : undefined;

interface Props {
    /**
     * The name of the file
     */
    filename: string,
    /**
     * The Blob of the file
     */
    content: Blob
}

/**
 * Download one or multiple files. The DownloadContent class also handles zip file creation or file sharing.
 */
export default class DownloadContent<T extends "zipblob" | "zipstream" | "share" | "link"> {
    /**
     * The type of the current file
     */
    #downloadType: T
    /**
     * The promise called to initialize the zip file
     */
    #promise: Promise<void>;
    /**
     * The iFrame element used to download the zip file in Safari
     */
    #iFrame: HTMLIFrameElement | null = null;
    /**
     * The main object used to download the item.
     */
    zip!: DownloadType<T>;
    /**
     * The ID of this download operation
     */
    operationId = getOperationId();

    /**
     * Create a link to download a binary file.
     * @param blob the Blob to download
     * @param filename the filename of the file
     * @returns the link used to download the file
     */
    #downloadLink = (blob: Blob, filename: string) => {
        let closeAlert: (() => void) | null = null;
        const a = Object.assign(document.createElement("a"), {
            href: URL.createObjectURL(blob),
            target: "_blank",
            download: filename,
            textContent: lang("Force download"),
            onclick: () => closeAlert && closeAlert()
        });
        a.click();
        closeAlert = CreateAlert(<span style={{wordBreak: "break-all"}}>{lang("Downloaded")} {a.download}</span>, a);
        return a;
    }

    /**
     * Make sure this Blob will be downloaded. This means that the Blob will be added in the zip file, will be added in the share array or will be directly downloaded.
     */
    downloadFile = async ({ filename, content }: Props) => {
        await this.#promise;
        try {
            switch (this.#downloadType) {
                case "zipblob": {
                    const file = this.zip as ZipWriter<Blob>;
                    const zipJs = await import("@zip.js/zip.js");
                    await file.add(filename, new zipJs.BlobReader(content));
                    break;
                }
                case "zipstream": {
                    const file = this.zip as ZipWriterStream;
                    await content.stream().pipeTo(file.writable(filename));
                    break;
                }
                case "share": {
                    (this.zip as File[]).push(new File([content], filename, { type: content.type }))
                    break;
                }
                case "link": {
                    this.#downloadLink(content, filename);
                    break;
                }
            }
        } catch (ex) { // Usually this is triggered when files have the same name
            console.warn(ex);
        }
    }


    /**
     * Close the download operation and download the output file if necessary.
     * @param filename the name of the output zip file
     */
    releaseFile = async (filename: string) => {
        switch (this.#downloadType) {
            case "zipblob": {
                this.#downloadLink(await (this.zip as ZipWriter<Blob>).close(), filename);
                break;
            }
            case "zipstream": {
                await (this.zip as ZipWriterStream).close();
                this.#iFrame?.remove();
                break;
            }
            case "share": {
                navigator.share({ files: this.zip as File[] });
                CreateAlert(<span>{lang("We tried to share the files.")} <span style={{ textDecoration: "underline" }} onClick={() => navigator.share({ files: this.zip as File[] })}>{lang("Share again")}</span></span>)
                break;
            }
        }
    }

    constructor(downloadType: T, name = `VideoFrameExtractor-${Date.now()}.zip`) {
        this.#downloadType = downloadType;
        this.#promise = new Promise(async (res) => { // Initialize the class
            switch (downloadType) {
                case "zipblob": {
                    const zipJs = await import("@zip.js/zip.js");
                    this.zip = new zipJs.ZipWriter(new zipJs.BlobWriter()) as DownloadType<T>;
                    break;
                }
                case "zipstream": {
                    const zipJs = await import("@zip.js/zip.js");
                    this.zip = new zipJs.ZipWriterStream() as DownloadType<T>;
                    const id = getOperationId();
                    (this.zip as ZipWriterStream).readable.pipeTo(new WritableStream({ // Create a new WritableStream that'll intercept the data written to the zip file and send it to the service worker
                        write: async (chunk) => {
                            const operationId = getOperationId();
                            await new Promise<void>(res => {
                                SWPromises.set(operationId, res); // Set it so that the script will continue only after the service worker sent as a message that this action was successfully completed.
                                navigator.serviceWorker.controller?.postMessage({
                                    action: "WriteFile",
                                    id,
                                    operationId,
                                    chunk
                                });
                            })
                        },
                        close: async () => {
                            const operationId = getOperationId();
                            await new Promise<void>(res => {
                                SWPromises.set(operationId, res);
                                navigator.serviceWorker.controller?.postMessage({
                                    action: "CloseFile",
                                    id,
                                    operationId
                                })
                            })
                        }
                    }));
                    await new Promise<void>(res => { // Create the zip file. 
                        const operationId = getOperationId();
                        SWPromises.set(operationId, res);
                        navigator.serviceWorker.controller?.postMessage({
                            action: "CreateFile",
                            id,
                            operationId,
                            name
                        });
                    });
                    /**
                    * Add an iFrame to the page to download the file. 
                    * This seems to work only on Safari, since it causes Chrome to crash and Firefox to block the resource. 
                    * I think that's the second time something works on Safari and not on Chrome, really surprised since usually it's the other way around.
                    */
                    function iFrameFallback() {
                        const iframe = document.createElement("iframe");
                        iframe.src = `${window.location.href}${window.location.href.endsWith("/") ? "" : "/"}downloader?id=${id}`;
                        iframe.style = "width: 1px; height: 1px; position: fixed; top: -1px; left: -1px; opacity: 0";
                        document.body.append(iframe);
                        return iframe;
                    }
                    if (!(/^((?!chrome|android).)*safari/i.test(navigator.userAgent))) { // Quick method to detect if Safari is being used. If not, open a pop-up window to download it (since otherwise it would fail).
                        const win = window.open(`${window.location.href}${window.location.href.endsWith("/") ? "" : "/"}downloader?id=${id}`, "_blank", "width=200,height=200");
                        if (!win) alert("A pop-up window was blocked. Please open it so that the download can start.");
                        (new Blob(["This file was automatically generated to close your browser's pop-up window. You can safely delete it."])).stream().pipeTo((this.zip as ZipWriterStream).writable("_.txt"));
                    } else this.#iFrame = iFrameFallback();
                    break;
                }
                case "link": {
                    this.zip = undefined as DownloadType<T>;
                    break;
                }
                case "share": {
                    this.zip = [] as File[] as DownloadType<T>;
                    break;
                }
            };
            res();
        })
    }
}

/**
 * Get an unique ID for a specific operation
 * @returns the ID
 */
function getOperationId() {
    return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString();
}
/**
 * The Map of Promises for the current operations between the main script and the service worker, tied to a ID.
 */
const SWPromises = new Map<string, () => void>([]);
/**
 * The BroadcastChannel used from the Service Worker to communicate to the main script
 */
const channel = new BroadcastChannel("SWComms");
channel.onmessage = (msg) => {
    const promise = SWPromises.get(msg.data);
    promise && promise();
}
