const cacheName = 'videoframeextractor-cache';
const filestoCache = [
    './',
    './index.html',
    './icon.png',
    './icon.svg',
    './manifest.json',
    './assets/index.css',
    './assets/index.js',
    './assets/index2.js',
];
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(cacheName)
            .then(cache => cache.addAll(filestoCache))
    );
});
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.url.indexOf("updatecode") !== -1) event.respondWith(fetch(req)); else event.respondWith(networkFirst(req));
});
/**
 * The BroadcastChannel used to communicate with the main window
 */
const comms = new BroadcastChannel("SWComms");
/**
 * The Map that contains the zip file ID as the key, and the TransformStream and its writer as a value.
 */
const zipStreams = new Map();
self.addEventListener("message", (msg) => {
    switch (msg.data.action) {
        case "CreateFile": {
            const stream = new TransformStream();
            zipStreams.set(msg.data.id, {
                stream,
                writer: stream.writable.getWriter(),
                name: msg.data.name
            });
            comms.postMessage(msg.data.operationId);
            break;
        }
        case "WriteFile": {
            zipStreams.get(msg.data.id)?.writer.write(msg.data.chunk).then(() => comms.postMessage(msg.data.operationId));
            break;
        }
        case "CloseFile": {
            zipStreams.get(msg.data.id)?.writer.close().then(() => comms.postMessage(msg.data.operationId));
            break;
        }
    }
})
function sanitizeFilename(filename) {
  // Remove or replace problematic characters
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Replace invalid chars with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .slice(0, 255); // Limit length
}

async function networkFirst(req) {
    const stream = zipStreams.get(req.url.substring(req.url.lastIndexOf("/downloader?id=") + "/downloader?id=".length)); // Look if the request is tied with a local zip file. In this case, the readable stream needs to be returned.
    if (stream) {
        return new Response(stream.stream.readable, {
            headers: {
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(stream.name))}`,
                "Content-Type": "application/zip"
            }
        })
    }
    try {
        const networkResponse = await fetch(req);
        const cache = await caches.open(cacheName);
        await cache.delete(req);
        await cache.put(req, networkResponse.clone());
        return networkResponse;
    } catch (error) {
        const cachedResponse = await caches.match(req);
        return cachedResponse;
    }
}