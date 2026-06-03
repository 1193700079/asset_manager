interface Props {
    /**
     * The video element used as a source for the canvas
     */
    video: HTMLVideoElement,
    /**
     * Output image quality. Must be a number between 0 and 1
     */
    quality: number,
    /**
     * The output image mimetype (without `image/`)
     */
    format: string,
    /**
     * The width of the output image
     */
    width?: number,
    /**
     * The height of the output image
     */
    height?: number
}
/**
 * Obtain a Blob with the current frame from the passed video
 * @returns the image Blob
 */
export default async function ExtractVideoFrame({video, quality, format, width, height}: Props) {
    const canvas = Object.assign(document.createElement("canvas"), {
        width: width ?? video.videoWidth,
        height: height ?? video.videoHeight
    });
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>(res => canvas.toBlob(blob => blob && res(blob), `image/${format}`, quality));
}