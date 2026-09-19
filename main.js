// main.js — Axiom Verge WASM Bootstrap & Runtime Host
import { dotnet } from './_framework/dotnet.js';

const canvas = document.getElementById("canvas");
const progressEl = document.getElementById("loading-progress");
const overlayEl = document.getElementById("loading-overlay");

if (canvas) {
    canvas.width = 480;
    canvas.height = 270;
}

function setStatus(msg) {
    console.log("[AxiomVerge] " + msg);
    if (progressEl) progressEl.textContent = msg;
}

setStatus("Initialising .NET WebAssembly runtime...");

globalThis.Module = globalThis.Module || {};
if (canvas) {
    globalThis.Module.canvas = canvas;
}

// Suppress modal alerts (e.g. FAudio assertion dialogs) from freezing the browser
const origAlert = window.alert;
window.alert = function(...args) {
    const msg = String(args[0] || '');
    if (msg.includes("Failed to open audio device") || msg.includes("Assertion failure") || msg.includes("FAudio")) {
        console.warn("[AxiomVerge Audio Alert Suppressed]", msg);
        return;
    }
    return origAlert ? origAlert.apply(this, args) : undefined;
};

// ---------------------------------------------------------------------------
// 1. Web Audio: Autoplay Unlock & Safe ScriptProcessor Clamping
// ---------------------------------------------------------------------------
const activeAudioContexts = new Set();
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

if (OrigAudioContext) {
    const WrappedAudioContext = function(...args) {
        let opts = args[0];
        if (!opts || typeof opts !== 'object') opts = {};
        else opts = Object.assign({}, opts);
        if (!opts.sampleRate) opts.sampleRate = 48000;
        const ctx = new OrigAudioContext(opts);
        activeAudioContexts.add(ctx);
        console.log("[AxiomVerge Audio] AudioContext created. Sample rate:", ctx.sampleRate, "State:", ctx.state);
        ctx.addEventListener('statechange', () => {
            console.log("[AxiomVerge Audio] AudioContext state:", ctx.state);
        });
        return ctx;
    };
    WrappedAudioContext.prototype = OrigAudioContext.prototype;

    const origCSP = OrigAudioContext.prototype.createScriptProcessor;
    if (origCSP) {
        OrigAudioContext.prototype.createScriptProcessor = function(bufferSize, inChannels, outChannels) {
            const validPowers = [256, 512, 1024, 2048, 4096, 8192, 16384];
            let clamped = bufferSize;
            if (!validPowers.includes(bufferSize)) {
                clamped = validPowers.reduce((best, p) =>
                    Math.abs(p - bufferSize) < Math.abs(best - bufferSize) ? p : best, 4096);
                console.warn(`[AxiomVerge Audio] Clamping bufferSize ${bufferSize} -> ${clamped}`);
            }
            return origCSP.call(this, clamped, inChannels, outChannels);
        };
    }

    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) {
        window.webkitAudioContext = WrappedAudioContext;
    }
}

function resumeAllAudio() {
    for (const ctx of activeAudioContexts) {
        if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
                console.log("[AxiomVerge Audio] AudioContext resumed successfully!");
            }).catch(err => {
                console.warn("[AxiomVerge Audio] AudioContext resume error:", err);
            });
        }
    }
    const sdl2 = globalThis.Module?.SDL2 || globalThis.SDL2 || window.SDL2;
    if (sdl2?.audioContext && sdl2.audioContext.state === 'suspended') {
        sdl2.audioContext.resume().catch(() => {});
    }
}

const unlockAudio = () => {
    resumeAllAudio();
};

['click', 'keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'touchstart', 'touchend'].forEach(evt => {
    window.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    document.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    if (canvas) canvas.addEventListener(evt, unlockAudio, { capture: true, passive: true });
});

// ---------------------------------------------------------------------------
// 2. Real-time FPS Counter Overlay
// ---------------------------------------------------------------------------
const fpsEl = document.getElementById("fps-counter");
let lastFpsTime = performance.now();
let fpsFrames = 0;

function fpsTick(now) {
    fpsFrames++;
    const elapsed = now - lastFpsTime;
    if (elapsed >= 500) {
        const currentFps = Math.round((fpsFrames * 1000) / elapsed);
        if (fpsEl) {
            fpsEl.textContent = `${currentFps} FPS`;
            if (currentFps >= 50) {
                fpsEl.style.color = "#4ade80";
                fpsEl.style.borderColor = "rgba(74, 222, 128, 0.35)";
            } else if (currentFps >= 28) {
                fpsEl.style.color = "#facc15";
                fpsEl.style.borderColor = "rgba(250, 204, 21, 0.35)";
            } else {
                fpsEl.style.color = "#f87171";
                fpsEl.style.borderColor = "rgba(248, 113, 113, 0.35)";
            }
        }
        fpsFrames = 0;
        lastFpsTime = now;

        if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
            resumeAllAudio();
        }
    }
    requestAnimationFrame(fpsTick);
}
requestAnimationFrame(fpsTick);

// ---------------------------------------------------------------------------
// 3. Virtual Filesystem Helpers & Content Preloader
// ---------------------------------------------------------------------------
function getDirname(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.substring(0, idx);
}

function ensureDirectoryExists(fs, dirPath) {
    if (!dirPath || dirPath === '/' || dirPath === '.') return;
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        try {
            if (typeof fs.analyzePath === 'function') {
                if (!fs.analyzePath(current).exists) {
                    fs.mkdir(current);
                }
            } else {
                fs.mkdir(current);
            }
        } catch (e) {
            // Already exists or parent error
        }
    }
}

const ASSET_CACHE_NAME = 'axiomverge-assets-v1';

async function preloadContent(FS) {
    if (!FS) {
        console.warn("[AxiomVerge] Emscripten FS not available, skipping asset preload.");
        return;
    }

    let files = [];
    try {
        const resp = await fetch("Content/manifest.json", { cache: "no-store" });
        if (resp.ok) files = await resp.json();
    } catch (e) {
        console.warn("[AxiomVerge] No Content/manifest.json found:", e);
    }

    if (files.length === 0) return;

    ensureDirectoryExists(FS, "/Content");

    let cache = null;
    if (typeof caches !== 'undefined') {
        try {
            cache = await caches.open(ASSET_CACHE_NAME);
            console.log("[AxiomVerge] Browser Cache Storage active.");
        } catch (e) {
            console.warn("[AxiomVerge] Cache Storage open failed:", e);
        }
    }

    let count = 0;
    const total = files.length;
    setStatus(`Pre-loading assets (0/${total})...`);

    const CONCURRENCY = 8;
    let nextIndex = 0;

    async function loadWorker() {
        while (nextIndex < files.length) {
            const idx = nextIndex++;
            const relPath = files[idx];
            const url = "Content/" + relPath;
            const virtPath = "/Content/" + relPath;
            const dir = getDirname(virtPath);
            if (dir) {
                ensureDirectoryExists(FS, dir);
            }

            try {
                // Check if already in MEMFS
                try {
                    const existingStat = FS.stat(virtPath);
                    if (existingStat && existingStat.size > 0) {
                        count++;
                        if (count % 20 === 0 || count === total) {
                            setStatus(`Pre-loading assets (${count}/${total})...`);
                        }
                        continue;
                    }
                } catch (_) {}

                let arrayBuf = null;
                if (cache) {
                    try {
                        const cachedResp = await cache.match(url);
                        if (cachedResp) {
                            arrayBuf = await cachedResp.arrayBuffer();
                        }
                    } catch (_) {}
                }

                if (!arrayBuf) {
                    const resp = await fetch(url);
                    if (!resp.ok) {
                        throw new Error(`HTTP ${resp.status} for ${url}`);
                    }
                    if (cache) {
                        try { await cache.put(url, resp.clone()); } catch (_) {}
                    }
                    arrayBuf = await resp.arrayBuffer();
                }

                FS.writeFile(virtPath, new Uint8Array(arrayBuf));
                count++;
                if (count % 20 === 0 || count === total) {
                    setStatus(`Pre-loading assets (${count}/${total})...`);
                }
            } catch (err) {
                console.warn(`[AxiomVerge] Failed to preload ${url}:`, err);
            }
        }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(loadWorker());
    }
    await Promise.all(workers);
    console.log(`[AxiomVerge] Asset preloading complete: ${count}/${total} files loaded into MEMFS.`);
}

// ---------------------------------------------------------------------------
// 4. Save Persistence (IDBFS & IndexedDB)
// ---------------------------------------------------------------------------
const SAVE_DB_NAME = "axiomverge-save-db";
const SAVE_STORE_NAME = "saves";
let isIDBFSMounted = false;
let isSyncing = false;
let saveIsDirty = false;

function openSaveDB() {
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(SAVE_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
                    db.createObjectStore(SAVE_STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (_) {
            resolve(null);
        }
    });
}

async function restoreSavesFromIDB(FS) {
    const db = await openSaveDB();
    if (!db) return;

    return new Promise((resolve) => {
        try {
            const tx = db.transaction(SAVE_STORE_NAME, "readonly");
            const store = tx.objectStore(SAVE_STORE_NAME);
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const filePath = cursor.key;
                    const data = cursor.value;
                    if (typeof filePath === 'string' && (filePath.includes("RogueLegacy") || filePath.includes("RogueCastle"))) {
                        cursor.continue();
                        return;
                    }
                    try {
                        const dir = getDirname(filePath);
                        if (dir) ensureDirectoryExists(FS, dir);
                        FS.writeFile(filePath, data);
                        console.log("[AxiomVerge] Restored save file:", filePath);
                    } catch (err) {
                        console.warn("[AxiomVerge] Restore save failed:", filePath, err);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        } catch (err) {
            console.warn("[AxiomVerge] IDB restore transaction error:", err);
            resolve();
        }
    });
}

async function persistSavesToIDB(FS, force = false) {
    if (!FS || isSyncing) return;
    if (!saveIsDirty && !force) return;

    isSyncing = true;
    try {
        if (isIDBFSMounted && typeof FS?.syncfs === 'function' && FS?.filesystems?.IDBFS) {
            await new Promise((resolve) => {
                FS.syncfs(false, (err) => {
                    if (err) console.warn("[AxiomVerge] IDBFS flush error:", err);
                    resolve();
                });
            });
        }

        const db = await openSaveDB();
        if (!db) {
            saveIsDirty = false;
            return;
        }

        function collectFiles(dir) {
            let results = [];
            try {
                const entries = FS.readdir(dir);
                for (const entry of entries) {
                    if (entry === '.' || entry === '..') continue;
                    const fullPath = dir === '/' ? '/' + entry : dir + '/' + entry;
                    try {
                        const stat = FS.stat(fullPath);
                        if (FS.isDir(stat.mode)) {
                            results = results.concat(collectFiles(fullPath));
                        } else if (FS.isFile(stat.mode)) {
                            results.push(fullPath);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
            return results;
        }

        const saveFiles = collectFiles("/save");
        if (saveFiles.length === 0) {
            saveIsDirty = false;
            return;
        }

        await new Promise((resolve) => {
            try {
                const tx = db.transaction(SAVE_STORE_NAME, "readwrite");
                const store = tx.objectStore(SAVE_STORE_NAME);
                for (const filePath of saveFiles) {
                    try {
                        const data = FS.readFile(filePath);
                        store.put(data, filePath);
                    } catch (err) {
                        console.warn("[AxiomVerge] Save backup write failed:", filePath, err);
                    }
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (err) {
                console.warn("[AxiomVerge] IDB persist transaction error:", err);
                resolve();
            }
        });
        saveIsDirty = false;
    } catch (err) {
        console.warn("[AxiomVerge] persistSavesToIDB error:", err);
    } finally {
        isSyncing = false;
    }
}

async function mountSave(FS) {
    if (!FS) {
        console.warn("[AxiomVerge] Emscripten FS not available, skipping save mount.");
        return;
    }

    ensureDirectoryExists(FS, "/save");

    const origWriteFile = FS.writeFile;
    if (origWriteFile && !FS._saveHookInstalled) {
        FS._saveHookInstalled = true;
        FS.writeFile = function(path, data, options) {
            if (typeof path === 'string' && path.startsWith('/save')) {
                saveIsDirty = true;
            }
            return origWriteFile.call(this, path, data, options);
        };
    }

    if (typeof FS.mount === 'function' && FS.filesystems?.IDBFS) {
        try {
            FS.mount(FS.filesystems.IDBFS, {}, "/save");
            await new Promise((resolve) => {
                FS.syncfs(true, (err) => {
                    if (err) console.warn("[AxiomVerge] IDBFS initial sync failed:", err);
                    resolve();
                });
            });
            isIDBFSMounted = true;
            console.log("[AxiomVerge] /save successfully mounted to IDBFS");
        } catch (e) {
            console.warn("[AxiomVerge] IDBFS mount failed, falling back to IDB storage:", e);
        }
    }

    console.log("[AxiomVerge] Syncing persistent saves from IndexedDB...");
    await restoreSavesFromIDB(FS);
}

// ---------------------------------------------------------------------------
// 5. Main Bootstrap
// ---------------------------------------------------------------------------
try {
    const runtime = await dotnet
        .withEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL2")
        .withDiagnosticTracing(false)
        .withModuleConfig({
            canvas: canvas
        })
        .create();

    if (runtime.Module && canvas) {
        runtime.Module.canvas = canvas;
    }
    if (canvas) {
        globalThis.Module.canvas = canvas;
    }

    const FS = runtime.Module?.FS || runtime.FS || globalThis.Module?.FS;

    setStatus("Mounting save storage and pre-loading assets...");
    await mountSave(FS);
    await preloadContent(FS);

    // Periodic throttled save flush & unload listeners
    const flushSaveData = (force = false) => {
        try {
            persistSavesToIDB(FS, force);
        } catch (_) {}
    };
    setInterval(() => flushSaveData(false), 10000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushSaveData(true);
    });
    window.addEventListener("beforeunload", () => flushSaveData(true));

    setStatus("Starting Axiom Verge engine...");
    window._gameReady = true;
    if (overlayEl) {
        overlayEl.classList.add("hidden");
    }

    // Ensure canvas binding is set right before running .NET entry point
    const activeCanvas = document.getElementById('canvas');
    if (globalThis.Module) {
        globalThis.Module.canvas = activeCanvas;
    }
    if (runtime && runtime.Module) {
        runtime.Module.canvas = activeCanvas;
    }
    console.log("[AxiomVerge JS] Canvas element verified before running .NET:", activeCanvas?.id, `${activeCanvas?.width}x${activeCanvas?.height}`);

    // Run the application entry point using runtime.runMain to keep the WASM runtime alive.
    // NOTE: dotnet.run() calls runtime.runMainAndExit() which invokes mono_exit() / exit(0)
    // upon Main() returning, killing the process and breaking the Emscripten RAF loop!
    if (typeof runtime.runMain === 'function') {
        console.log("[AxiomVerge JS] Invoking runtime.runMain('AxiomVerge.Web', [])...");
        await runtime.runMain("AxiomVerge.Web", []);
        console.log("[AxiomVerge JS] runtime.runMain returned cleanly; runtime remains active for RAF loop.");
    } else {
        console.log("[AxiomVerge JS] Fallback: Invoking dotnet.run()...");
        await dotnet.run();
    }
} catch (err) {
    console.error("[AxiomVerge Fatal Error]", err);
    if (progressEl) progressEl.textContent = "Fatal Error: " + (err.message || err);
}
