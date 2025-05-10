'use client';

import React, {
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import Script from 'next/script';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

/* ---------- constants & types ---------- */
type ModelId = 'tiny.en' | 'base.en' | 'tiny-en-q5_1' | 'base-en-q5_1';
interface ModelMeta {
    url: string;
    sizeMB: number;
}
const MODELS: Record<ModelId, ModelMeta> = {
    'tiny.en': {
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
        sizeMB: 75,
    },
    'base.en': {
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
        sizeMB: 142,
    },
    'tiny-en-q5_1': {
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin',
        sizeMB: 31,
    },
    'base-en-q5_1': {
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
        sizeMB: 57,
    },
};

const DB_NAME = 'whisper-model-cache';
const DB_STORE = 'models';
const WASM_MODEL = 'whisper.bin';

const SAMPLE_RATE = 16_000;

/* ---------- tiny IndexedDB helper ---------- */
function openDB(): Promise<IDBDatabase> {
    return new Promise((ok, err) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => ok(req.result);
        req.onerror = () => err(req.error);
    });
}
async function getCached(key: string): Promise<Uint8Array | null> {
    const db = await openDB();
    return new Promise(res => {
        const r = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
        r.onsuccess = () => res(r.result ? new Uint8Array(r.result) : null);
        r.onerror = () => res(null);
    });
}
async function putCached(key: string, data: Uint8Array) {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(data, key);
}

/* ---------- component ---------- */
export default function StreamClient() {
    /* refs ----------------------------------------------------------- */
    const transcriptRef = useRef<HTMLDivElement>(null);
    const logRef = useRef<HTMLTextAreaElement>(null);
    const statusRef = useRef<HTMLSpanElement>(null);

    const instanceRef = useRef<number | null>(null);
    const contextRef = useRef<AudioContext | null>(null);
    const accAudioRef = useRef<Float32Array | null>(null);
    const pollTimerRef = useRef<number | null>(null);

    /* state ---------------------------------------------------------- */
    const [wasmReady, setWasmReady] = useState(false);
    const [ready, setReady] = useState(false);
    const [downloadPct, setPct] = useState<number | null>(null);
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscriptPinned, setIsTranscriptPinned] = useState(true);
    const [selectedModelId, setSelectedModelId] = useState<ModelId | null>(null);
    // Track which models are cached
    const [cachedModels, setCachedModels] = useState<Record<ModelId, boolean>>({} as Record<ModelId, boolean>);
    // Add state for debug log visibility
    const [showDebugLog, setShowDebugLog] = useState(false);
    // Modal state
    const [pendingModelId, setPendingModelId] = useState<ModelId | null>(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);

    /* log helper ----------------------------------------------------- */
    const log = useCallback((msg: string) => {
        console.log(msg);
        if (!logRef.current) return;
        logRef.current.value += `${msg}\n`;
        logRef.current.scrollTop = logRef.current.scrollHeight;
    }, []);

    /* expose printTextarea for legacy scripts ----------------------- */
    useEffect(() => {
        (window as any).printTextarea = log;
    }, [log]);

    // Check cache status on mount and when models change
    useEffect(() => {
        let isMounted = true;
        (async () => {
            const result: Record<ModelId, boolean> = {} as Record<ModelId, boolean>;
            for (const id of Object.keys(MODELS) as ModelId[]) {
                const cached = await getCached(id);
                if (!isMounted) return;
                result[id] = !!cached;
            }
            setCachedModels(result);
        })();
        return () => { isMounted = false; };
    }, []);

    // When a model is cached, update the cache state
    const markModelCached = (id: ModelId) => {
        setCachedModels(prev => ({ ...prev, [id]: true }));
    };

    /* ---------- helpers ------------------------------------------- */
    const writeModelToFS = (bytes: Uint8Array) => {
        try {
            if (typeof window.Module?.FS_unlink === "function") {
                window.Module.FS_unlink(WASM_MODEL);
            }
        } catch { }
        if (typeof window.Module?.FS_createDataFile === "function") {
            window.Module.FS_createDataFile('/', WASM_MODEL, bytes, true, true);
        } else {
            log('js: FS_createDataFile is not available on the WASM module.');
            // Optionally, throw or handle this case as needed
        }
    };

    const clearCache = async () => {
        log('js: clearing model cache...');
        try {
            const db = await openDB();
            const tx = db.transaction(DB_STORE, 'readwrite');
            await new Promise<void>((resolve, reject) => {
                const req = tx.objectStore(DB_STORE).clear();
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            log('js: model cache cleared successfully');
            setReady(false);
            setCachedModels({} as Record<ModelId, boolean>);
            setSelectedModelId(null);
        } catch (error) {
            log(`js: failed to clear cache: ${error}`);
        }
    };

    // --- Improved fetchWithProgress -------------------------------------------------
    const fetchWithProgress = async (
        url: string,
        cb: (pct: number) => void
    ): Promise<Uint8Array> => {
        // helper so we can sprinkle logs everywhere
        const dbg = (m: string) => log(`download: ${m}`);

        dbg(`requesting ${url}`);

        let response: Response;
        try {
            response = await fetch(url, { credentials: "omit", cache: "no-cache" });
        } catch (err) {
            dbg(`network error → ${err}`);
            throw err;
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const contentLength = Number(response.headers.get("Content-Length")) || 0;
        dbg(
            `response ok – ${contentLength ? `${(contentLength / 1_048_576).toFixed(1)} MB` : "size unknown"
            }`
        );

        /* ---------- 1. streaming path ------------------------------------------------ */
        if (response.body && typeof response.body.getReader === "function") {
            try {
                dbg("using streaming reader (ReadableStream)");
                const reader = response.body.getReader();

                const chunks: Uint8Array[] = [];
                let received = 0;

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) {
                        chunks.push(value);
                        received += value.length;

                        // update progress bar
                        if (contentLength) {
                            cb(received / contentLength);
                        } else {
                            // fall back to coarse updates every 5 MB
                            if (received % (5 * 1_048_576) < value.length) {
                                dbg(`received ${(received / 1_048_576).toFixed(1)} MB`);
                            }
                        }
                    }
                }

                cb(1); // make sure the UI shows 100 %
                dbg("stream finished, stitching chunks");

                const out = new Uint8Array(received);
                let pos = 0;
                for (const c of chunks) {
                    out.set(c, pos);
                    pos += c.length;
                }
                dbg("done ✅");
                return out;
            } catch (err) {
                // Some browsers (Safari) occasionally abort the stream – fall back below
                dbg(`streaming failed → ${err}`);
            }
        } else {
            dbg("ReadableStream not supported, falling back to arrayBuffer()");
        }

        /* ---------- 2. arrayBuffer() fallback --------------------------------------- */
        dbg("downloading via arrayBuffer() (no progress events)");
        const buf = await response.arrayBuffer();
        cb(1);
        dbg(`arrayBuffer() finished – ${(buf.byteLength / 1_048_576).toFixed(1)} MB`);
        return new Uint8Array(buf);
    };

    /* ---------- model loader -------------------------------------- */
    const loadModel = async (id: ModelId) => {
        setSelectedModelId(id);
        setReady(false);
        setPct(null);
        log(`js: loading model "${id}" …`);

        // Wait until the runtime exists – otherwise FS_* helpers are not there
        if (!window._wasmReady) {
            log('js: waiting for WASM runtime …');
            await new Promise<void>(ok => {
                const t = setInterval(() => {
                    if (window._wasmReady) { clearInterval(t); ok(); }
                }, 50);
            });
        }

        const cached = await getCached(id);
        if (cached) {
            log(`js: using cached copy (${(cached.length / 1_048_576).toFixed(1)} MB)`);
            writeModelToFS(cached);
            setReady(true);
            markModelCached(id);
            return;
        }

        try {
            const bytes = await fetchWithProgress(MODELS[id].url, setPct);
            setPct(1);
            writeModelToFS(bytes);
            await putCached(id, bytes);
            log('js: model cached');
            setReady(true);
            markModelCached(id);
        } catch (e) {
            log(`js: download failed → ${e}`);
        }
    };

    type RecorderHandles = {
        stream: MediaStream;
        source: MediaStreamAudioSourceNode;
        proc: ScriptProcessorNode;
    };
    const recorderRef = useRef<RecorderHandles | null>(null);

    const startRecording = async () => {
        /* one AudioContext for the whole session */
        if (!contextRef.current) {
            contextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
            await contextRef.current.audioWorklet?.addModule?.('/whisper/stream/dummy.js').catch(() => { });
        }
        const ctx = contextRef.current;

        /* mic stream --------------------------------------------------- */
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = ctx.createMediaStreamSource(stream);

        /* fallback ScriptProcessorNode (works everywhere) -------------- */
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = e => {
            const input = e.inputBuffer.getChannelData(0);
            /* copy the frame because the underlying buffer is recycled */
            const chunk = new Float32Array(input);

            /* accumulate -------------------------------------------------- */
            const prev = accAudioRef.current;
            const merged = new Float32Array((prev?.length ?? 0) + chunk.length);
            if (prev) merged.set(prev);
            merged.set(chunk, prev?.length ?? 0);
            accAudioRef.current = merged;

            /* send to WASM ----------------------------------------------- */
            if (instanceRef.current)
                window.Module?.set_audio?.(instanceRef.current, merged);
        };

        source.connect(proc);
        proc.connect(ctx.destination);      // required in Firefox

        recorderRef.current = { stream, source, proc };
    };

    const stopRecording = () => {
        if (!recorderRef.current) return;
        const { stream, source, proc } = recorderRef.current;
        proc.disconnect();
        source.disconnect();
        stream.getTracks().forEach(t => t.stop());
        recorderRef.current = null;

        /* keep the AudioContext alive – Whisper re-uses it */
        accAudioRef.current = null;
    };

    /* ---------- start / stop buttons ------------------------------ */
    const startWhisper = () => {
        if (!ready) return;
        if (!wasmReady || !ready) {
            log('js: Not ready (wasmReady=' + wasmReady + ', modelReady=' + ready + ')');
            return;
        }
        if (!instanceRef.current) {
            instanceRef.current = window.Module?.init?.(WASM_MODEL);
            log(`js: whisper init → ${instanceRef.current}`);
        }
        startRecording().catch(err => log(`js: mic error ${err}`));
        setIsRecording(true);

        pollTimerRef.current = window.setInterval(() => {
            const txt = window.Module?.get_transcribed?.();
            if (txt && transcriptRef.current) {
                transcriptRef.current.textContent += txt + '\n';
                if (isTranscriptPinned) {
                    scrollTranscriptToBottom();
                }
            }
            statusRef.current!.textContent = window.Module?.get_status?.() ?? '';
        }, 150);
    };

    const stopWhisper = () => {
        stopRecording();
        setIsRecording(false);
        if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    };

    /* ---------- render ------------------------------------------- */
    // Helper to scroll transcript to bottom
    const scrollTranscriptToBottom = useCallback(() => {
        const el = transcriptRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, []);

    // onScroll handler for transcript
    const handleTranscriptScroll = useCallback(() => {
        const el = transcriptRef.current;
        if (!el) return;
        // Consider "pinned" if within 10px of the bottom
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
        setIsTranscriptPinned(pinned);
    }, []);

    // --- Modal logic for confirmation before download ---
    const handleModelButtonClick = (id: ModelId) => {
        if (cachedModels[id]) {
            // If model is already cached, load it directly (no dialog)
            loadModel(id);
        } else {
            setPendingModelId(id);
            setShowConfirmModal(true);
        }
    };

    const handleConfirmDownload = async () => {
        if (pendingModelId) {
            setShowConfirmModal(false);
            await loadModel(pendingModelId);
            setPendingModelId(null);
        }
    };

    const handleCancelDownload = () => {
        setShowConfirmModal(false);
        setPendingModelId(null);
    };

    // add right below the other useEffects
    useEffect(() => {
        // if the runtime was already ready before React mounted
        if ((window as any)._wasmReady) setWasmReady(true);

        const handler = () => setWasmReady(true);
        window.addEventListener("wasm-ready", handler);
        return () => window.removeEventListener("wasm-ready", handler);
    }, []);

    return (
        <>
            {/* 1. Define Module BEFORE loading WASM */}
            <Script id="define-module" strategy="beforeInteractive">
                {`
                    window.Module = {
                        print: msg => window.printTextarea && window.printTextarea(msg),
                        printErr: msg => window.printTextarea && window.printTextarea(msg),
                        onRuntimeInitialized() {
                            window._wasmReady = true;                // flag
                            window.dispatchEvent(new Event("wasm-ready")); // ✨ notify React
                            if (window.printTextarea) window.printTextarea("js: WASM runtime initialised 👍");
                        }
                    };
                    window._wasmReady = false;
                `}
            </Script>
            {/* 2. Load helpers and WASM glue */}
            <Script src="/whisper/stream/helpers.js" strategy="afterInteractive" />
            <Script src="/whisper/stream/stream.js" strategy="afterInteractive" />

            <div className="container mx-auto px-4 py-8 max-w-4xl">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-center sm:text-left">
                            Real-time Speech Recognition, 100% Client-side
                        </h1>
                        <h2 className="text-2xl font-bold mt-2 text-center sm:text-left text-muted-foreground">
                            Powered by Next.js, TypeScript, and Shadcn/UI
                        </h2>
                    </div>
                    <a
                        href="https://github.com/enesgrahovac/whisper.cpp-nextjs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black text-white hover:bg-gray-800 transition-colors shadow-md border border-gray-800"
                        aria-label="View on GitHub"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="20"
                            height="20"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            className="inline-block"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.339-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.987 1.029-2.686-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.295 2.748-1.025 2.748-1.025.546 1.378.202 2.397.1 2.65.64.699 1.028 1.593 1.028 2.686 0 3.847-2.337 4.695-4.566 4.944.359.309.678.919.678 1.852 0 1.336-.012 2.417-.012 2.747 0 .268.18.579.688.481C19.138 20.2 22 16.447 22 12.021 22 6.484 17.523 2 12 2z"
                            />
                        </svg>
                        <span className="font-medium">GitHub</span>
                    </a>
                </div>

                <Card className="mb-8">
                    <CardHeader>
                        <CardTitle>Select Model</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-col gap-3 sm:grid sm:grid-cols-2 md:grid-cols-4">
                            {(Object.keys(MODELS) as ModelId[]).map(id => (
                                <Button
                                    key={id}
                                    variant={
                                        selectedModelId === id
                                            ? "default"
                                            : ready && downloadPct === 1
                                                ? "secondary"
                                                : "outline"
                                    }
                                    onClick={() => handleModelButtonClick(id)}
                                    disabled={downloadPct !== null && downloadPct < 1}
                                    className={`w-full flex flex-col items-start justify-center px-3 py-2 min-h-[56px] ${selectedModelId === id ? "ring-2 ring-primary" : ""}`}
                                >
                                    <div className="flex items-center w-full">
                                        {selectedModelId === id && (
                                            <span className="mr-2">✅</span>
                                        )}
                                        <span className="font-semibold">{id}</span>
                                    </div>
                                    <span className="text-xs text-muted-foreground mt-1">
                                        {cachedModels[id]
                                            ? "cached"
                                            : `${MODELS[id].sizeMB} MB`}
                                    </span>
                                </Button>
                            ))}
                        </div>

                        {downloadPct !== null && downloadPct < 1 && (
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span>Downloading</span>
                                    <span>{(downloadPct * 100).toFixed(1)}%</span>
                                </div>
                                <Progress value={downloadPct * 100} />
                            </div>
                        )}

                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                Status:
                                <Badge variant={ready ? "success" : "secondary"}>
                                    {ready ? 'Ready' : downloadPct !== null ? `Downloading` : 'Idle'}
                                </Badge>
                            </div>
                            <Button
                                variant="outline"
                                onClick={clearCache}
                            >
                                Clear Cache
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card className="mb-8">
                    <CardHeader>
                        <CardTitle className="flex items-center justify-between">
                            <span>Transcription</span>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-normal">Status:</span>
                                <Badge variant={isRecording ? "default" : "outline"}>
                                    <span ref={statusRef}>not started</span>
                                </Badge>
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div
                            ref={transcriptRef}
                            className="min-h-[200px] max-h-[300px] overflow-y-auto p-4 rounded-md bg-muted/50 font-mono text-sm mb-4"
                            style={{ whiteSpace: 'pre-line' }}
                            onScroll={handleTranscriptScroll}
                        >
                            [transcription will appear here]
                        </div>

                        <div className="flex gap-3 w-full">
                            <Button
                                onClick={startWhisper}
                                disabled={!ready || !wasmReady || isRecording}
                                variant={isRecording ? "secondary" : "default"}
                                className="flex-1"
                            >
                                Start Recording
                            </Button>
                            <Button
                                onClick={stopWhisper}
                                disabled={!isRecording}
                                variant="destructive"
                                className="flex-1"
                            >
                                Stop Recording
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Add a toggle button for advanced users */}
                <div className="flex justify-end mb-4">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowDebugLog(v => !v)}
                    >
                        {showDebugLog ? "Hide Debug Log" : "Show Debug Log"}
                    </Button>
                </div>

                {/* Conditionally render the debug log */}
                {showDebugLog && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Debug Log</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Textarea
                                ref={logRef}
                                rows={10}
                                className="font-mono text-xs bg-black text-green-400 resize-none min-h-[150px] max-h-[150px] overflow-y-auto"
                                readOnly
                            />
                        </CardContent>
                    </Card>
                )}

                {/* --- Confirmation Modal --- */}
                <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Download Model?</DialogTitle>
                        </DialogHeader>
                        <div>
                            <p>
                                This model is about <b>{pendingModelId ? MODELS[pendingModelId].sizeMB : ''} MB</b> and will be downloaded to your device for fast, private transcription.
                                <br />
                                You can easily delete it later by clicking <b>Clear Cache</b>.
                            </p>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={handleCancelDownload}>Cancel</Button>
                            <Button onClick={handleConfirmDownload}>Download</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </>
    );
}