'use client';

/*
  StreamClient – complete end‑to‑end page:
    • Dynamic catalogue (via HF API) + <ModelSelector>
    • IndexedDB caching & download progress
    • Recording / transcription UI – unchanged from original

  All occurrences of the old MODELS/ModelId union have been removed.
  Model ids are now plain strings (the ggml‑*.bin filenames).
*/

import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import Script from 'next/script';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import ModelSelector from '@/components/ModelSelector';
import type { ModelMeta } from '@/components/ModelSelector';

/* ------------------------------- constants ------------------------ */
const HF_API =
    'https://huggingface.co/api/models/ggerganov/whisper.cpp?expand=siblings';

/** fall‑back list for offline */
const FALLBACK_BINS = [
    'ggml-tiny.en-q5_1.bin',
    'ggml-base.en-q5_1.bin',
    'ggml-small.en-q5_1.bin',
    'ggml-large-v3-turbo-q5_0.bin',
    'ggml-large-v3-turbo-q8_0.bin',
];

const DB_NAME = 'whisper-model-cache';
const DB_STORE = 'models';
const WASM_MODEL = 'whisper.bin';
const SAMPLE_RATE = 16_000;
/* --------------------------- helpers ------------------------------ */
function parseFilename(fname: string): Omit<ModelMeta, "url" | "sizeMB"> {
    /* strip prefix + .bin ---------------------------------------------------- */
    let name = fname.replace(/^ggml-/, "").replace(/\.bin$/, "");

    /* language ----------------------------------------------------------------*/
    const lang: "en" | "multi" = name.includes(".en") ? "en" : "multi";
    name = name.replace(".en", "");

    /* quantisation ----------------------------------------------------------- */
    const qMatch = fname.match(/-(q\d_?\d?)\.bin$/);          //  q8_0  |  q5_1 …
    const quant = qMatch ? qMatch[1] : null;
    if (quant) name = name.replace(`-${quant}`, "");          // remove for split

    /* split remaining tokens ------------------------------------------------- */
    const parts = name.split("-");
    const version = parts.shift()!;                           // tiny | base | …
    let rev: string | null = null;                            // v1 | v2 | v3
    if (parts[0]?.startsWith("v")) rev = parts.shift()!;

    const variant = parts.length ? parts.join("-") : null;    // turbo | fp16 | …

    return {
        id: fname,
        version,          // e.g. large
        rev,              // e.g. v3
        variant,          // e.g. turbo
        lang,             // en | multi
        quant,            // q5_0 | null
    };
}

async function headSizeMB(url: string): Promise<number | null> {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        const len = res.headers.get('Content-Length');
        return len ? +len / 1_048_576 : null;
    } catch {
        return null;
    }
}

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
    return new Promise((res) => {
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

/* ------------------------------------------------------------------
   component
------------------------------------------------------------------ */
export default function StreamClient() {
    /* ----------------------- catalogue ----------------------------- */
    const [models, setModels] = useState<ModelMeta[]>([]);
    const [fetchError, setFetchError] = useState<string | null>(null);

    /* cache awareness */
    const [cachedModels, setCachedModels] = useState<Record<string, boolean>>({});

    /* selection & download state */
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [downloadPct, setPct] = useState<number | null>(null);
    const [ready, setReady] = useState(false);

    /* modal */
    const [pendingModelId, setPendingModelId] = useState<string | null>(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);

    /* WASM runtime flag */
    const [wasmReady, setWasmReady] = useState(false);

    /* recording state */
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscriptPinned, setIsTranscriptPinned] = useState(true);
    const [showDebugLog, setShowDebugLog] = useState(false);

    /* refs ----------------------------------------------------------- */
    const transcriptRef = useRef<HTMLDivElement>(null);
    const logRef = useRef<HTMLTextAreaElement>(null);
    const statusRef = useRef<HTMLSpanElement>(null);
    const instanceRef = useRef<number | null>(null);
    const contextRef = useRef<AudioContext | null>(null);
    const accAudioRef = useRef<Float32Array | null>(null);
    const pollTimerRef = useRef<number | null>(null);
    const recorderRef = useRef<{
        stream: MediaStream;
        source: MediaStreamAudioSourceNode;
        proc: ScriptProcessorNode;
    } | null>(null);
    const downloadAbortRef = useRef<AbortController | null>(null);

    /* -------------------- logging helper --------------------------- */
    const log = useCallback((msg: string) => {
        console.log(msg);
        if (!logRef.current) return;
        logRef.current.value += `${msg}\n`;
        logRef.current.scrollTop = logRef.current.scrollHeight;
    }, []);

    useEffect(() => {
        (window as any).printTextarea = log;
    }, [log]);

    /* -------------------- load catalogue --------------------------- */
    /* catalogue fetch */
    useEffect(() => {
        (async () => {
            try {
                const r = await fetch(HF_API, { cache: 'force-cache' });
                const j = await r.json();
                const cat: ModelMeta[] = j.siblings.filter((f: any) => f.rfilename.endsWith('.bin')).map((f: any) => ({
                    ...parseFilename(f.rfilename),
                    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f.rfilename}`,
                    sizeMB: null,
                }));
                /* parallel HEAD size fetch */
                await Promise.all(cat.map(async m => { m.sizeMB = await headSizeMB(m.url); }));
                setModels(cat);
            } catch (e: any) {
                setFetchError(e.message);
                setModels(FALLBACK_BINS.map(id => ({ ...parseFilename(id), url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${id}`, sizeMB: null })));
            }
        })();
    }, []);

    /* -------------------- compute grouping ------------------------- */
    const grouped = useMemo(() => {
        const out: Record<string, ModelMeta[]> = {};
        for (const m of models) (out[m.version] ||= []).push(m);
        for (const v in out) {
            out[v].sort((a, b) => {
                if (a.lang !== b.lang) return a.lang === 'multi' ? -1 : 1;
                if (a.quant === b.quant) return 0;
                if (a.quant === null) return -1;
                if (b.quant === null) return 1;
                return a.quant!.localeCompare(b.quant!);
            });
        }
        return out;
    }, [models]);

    /* ------------------ cache presence check ----------------------- */
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const map: Record<string, boolean> = {};
            for (const m of models) {
                const c = await getCached(m.id);
                if (cancelled) return;
                map[m.id] = !!c;
            }
            setCachedModels(map);
        })();
        return () => {
            cancelled = true;
        };
    }, [models]);

    const markModelCached = (id: string) =>
        setCachedModels((p) => ({ ...p, [id]: true }));

    /* -------------------- WASM helpers ----------------------------- */
    const writeModelToFS = (bytes: Uint8Array) => {
        try {
            if (typeof window.Module?.FS_unlink === 'function') {
                window.Module.FS_unlink(WASM_MODEL);
            }
        } catch { }
        window.Module?.FS_createDataFile?.('/', WASM_MODEL, bytes, true, true);
    };

    const fetchWithProgress = async (
        url: string,
        cb: (pct: number) => void,
        abortController?: AbortController
    ): Promise<Uint8Array> => {
        const r = await fetch(url, { signal: abortController?.signal });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        const total = Number(r.headers.get('Content-Length')) || 0;
        const reader = r.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                received += value.length;
                if (total) cb(received / total);
            }
        }
        const out = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) {
            out.set(c, pos);
            pos += c.length;
        }
        return out;
    };

    /* -------------------- model loader ----------------------------- */
    const loadModel = useCallback(
        async (id: string) => {
            const meta = models.find((m) => m.id === id);
            if (!meta) return;
            setSelectedModelId(id);
            setReady(false);
            setPct(null);
            log(`js: loading model "${id}" …`);

            if (!window._wasmReady) {
                log('js: waiting for WASM runtime …');
                await new Promise<void>((ok) => {
                    const t = setInterval(() => {
                        if (window._wasmReady) {
                            clearInterval(t);
                            ok();
                        }
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

            const abortController = new AbortController();
            downloadAbortRef.current = abortController;

            try {
                const bytes = await fetchWithProgress(meta.url, setPct, abortController);
                setPct(1);
                writeModelToFS(bytes);
                await putCached(id, bytes);
                log('js: model cached');
                setReady(true);
                markModelCached(id);
            } catch (e: any) {
                if (e.name === 'AbortError') {
                    log('js: download cancelled');
                } else {
                    log(`js: download failed → ${e}`);
                }
            } finally {
                downloadAbortRef.current = null;
            }
        },
        [models, log],
    );

    const handleCancelDownload = () => {
        if (downloadAbortRef.current) {
            downloadAbortRef.current.abort();
            setPct(null);
            setSelectedModelId(null);
            setReady(false);
        }
    };

    /* ------------------- audio & recording ------------------------- */
    const startRecording = async () => {
        if (!contextRef.current) {
            contextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
            await contextRef.current.audioWorklet?.addModule?.('/whisper/stream/dummy.js').catch(() => { });
        }
        const ctx = contextRef.current;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const chunk = new Float32Array(input);
            const prev = accAudioRef.current;
            const merged = new Float32Array((prev?.length ?? 0) + chunk.length);
            if (prev) merged.set(prev);
            merged.set(chunk, prev?.length ?? 0);
            accAudioRef.current = merged;
            if (instanceRef.current) window.Module?.set_audio?.(instanceRef.current, merged);
        };
        source.connect(proc);
        proc.connect(ctx.destination);
        recorderRef.current = { stream, source, proc } as any;
    };

    const stopRecording = () => {
        if (!recorderRef.current) return;
        const { stream, source, proc } = recorderRef.current;
        proc.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        accAudioRef.current = null;
    };

    const startWhisper = () => {
        if (!ready || !wasmReady) return;
        if (!instanceRef.current) {
            instanceRef.current = window.Module?.init?.(WASM_MODEL);
            log(`js: whisper init → ${instanceRef.current}`);
        }
        startRecording().catch((err) => log(`js: mic error ${err}`));
        setIsRecording(true);
        pollTimerRef.current = window.setInterval(() => {
            const txt = window.Module?.get_transcribed?.();
            if (txt && transcriptRef.current) {
                transcriptRef.current.textContent += txt + '\n';
                if (isTranscriptPinned) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
            }
            statusRef.current!.textContent = window.Module?.get_status?.() ?? '';
        }, 150);
    };

    const stopWhisper = () => {
        stopRecording();
        setIsRecording(false);
        if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
        if (statusRef.current) statusRef.current.textContent = 'recording stopped';
    };

    /* ------------------- scroll helper ----------------------------- */
    const handleTranscriptScroll = useCallback(() => {
        const el = transcriptRef.current;
        if (!el) return;
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
        setIsTranscriptPinned(pinned);
    }, []);

    /* ------------------- modal logic ------------------------------- */
    const requestModel = (id: string) => {
        if (cachedModels[id]) loadModel(id);
        else {
            setPendingModelId(id);
            setShowConfirmModal(true);
        }
    };

    const confirmDownload = async () => {
        if (pendingModelId) {
            setShowConfirmModal(false);
            await loadModel(pendingModelId);
            setPendingModelId(null);
        }
    };

    /* ------------------- wasm ready listener ----------------------- */
    useEffect(() => {
        if ((window as any)._wasmReady) setWasmReady(true);
        const handler = () => setWasmReady(true);
        window.addEventListener('wasm-ready', handler);
        return () => window.removeEventListener('wasm-ready', handler);
    }, []);

    /* ------------------------ render ------------------------------- */
    const groupedMemo = grouped; // just to satisfy eslint hooks
    const pendingSizeMB = useMemo(() => {
        if (!pendingModelId) return null
        const hit = models.find((m) => m.id === pendingModelId)
        return hit?.sizeMB ?? null
    }, [pendingModelId, models])
    return (
        <>
            {/* WASM module definition & glue */}
            <Script id="define-module" strategy="beforeInteractive">
                {`
          window.Module = {
            print: msg => window.printTextarea && window.printTextarea(msg),
            printErr: msg => window.printTextarea && window.printTextarea(msg),
            onRuntimeInitialized() {
              window._wasmReady = true;
              window.dispatchEvent(new Event('wasm-ready'));
              if (window.printTextarea) window.printTextarea('js: WASM runtime initialised 👍');
            }
          };
          window._wasmReady = false;
        `}
            </Script>
            <Script src="/whisper/stream/helpers.js" strategy="afterInteractive" />
            <Script src="/whisper/stream/stream.js" strategy="afterInteractive" />

            <div className="container mx-auto px-4 py-8 max-w-4xl">
                {/* header -------------------------------------------------- */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-center sm:text-left">Real-time Speech Recognition, 100% Client-side</h1>
                        <h2 className="text-2xl font-bold mt-2 text-center sm:text-left text-muted-foreground">Powered by Next.js, TypeScript, and Shadcn/UI</h2>
                    </div>
                    <a
                        href="https://github.com/enesgrahovac/whisper.cpp-nextjs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-black text-white hover:bg-gray-800 transition-colors shadow-md border border-gray-800"
                        aria-label="View on GitHub"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.339-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.987 1.029-2.686-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.295 2.748-1.025 2.748-1.025.546 1.378.202 2.397.1 2.65.64.699 1.028 1.593 1.028 2.686 0 3.847-2.337 4.695-4.566 4.944.359.309.678.919.678 1.852 0 1.336-.012 2.417-.012 2.747 0 .268.18.579.688.481C19.138 20.2 22 16.447 22 12.021 22 6.484 17.523 2 12 2z" />
                        </svg>
                        <span className="font-medium">GitHub</span>
                    </a>
                </div>

                {/* model selector ----------------------------------------- */}
                <ModelSelector
                    grouped={groupedMemo}
                    fetchError={fetchError}
                    selectedId={selectedModelId}
                    onSelect={requestModel}
                    downloadPct={downloadPct}
                    ready={ready}
                    onClearCache={async () => {
                        log("js: clearing model cache …");
                        const db = await openDB();
                        await new Promise<void>((ok, err) => {
                            const tx = db.transaction(DB_STORE, "readwrite");
                            const r = tx.objectStore(DB_STORE).clear();
                            r.onsuccess = () => ok();
                            r.onerror = () => err(r.error);
                        });
                        setCachedModels({});
                        setReady(false);
                        setSelectedModelId(null);
                        setPct(null);
                    }}
                    onCancelDownload={handleCancelDownload}
                />

                {/* transcription ------------------------------------------ */}
                <Card className="mb-8">
                    <CardHeader>
                        <CardTitle className="flex items-center justify-between">
                            <span>Transcription</span>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-normal">Status:</span>
                                <Badge variant={isRecording ? 'default' : 'outline'}>
                                    <span ref={statusRef}>not started</span>
                                </Badge>
                            </div>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div
                            ref={transcriptRef}
                            className="h-[300px] overflow-y-auto p-4 rounded-md bg-muted/50 font-mono text-sm mb-4"
                            style={{ whiteSpace: 'pre-line' }}
                            onScroll={handleTranscriptScroll}
                        >
                            [transcription will appear here]
                        </div>
                        <div className="flex gap-3 w-full">
                            <Button
                                onClick={startWhisper}
                                disabled={!ready || !wasmReady || isRecording}
                                variant={isRecording ? 'secondary' : 'default'}
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

                {/* debug log ---------------------------------------------- */}
                <div className="flex justify-end mb-4">
                    <Button variant="outline" size="sm" onClick={() => setShowDebugLog((v) => !v)}>
                        {showDebugLog ? 'Hide Debug Log' : 'Show Debug Log'}
                    </Button>
                </div>
                {showDebugLog && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Debug Log</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Textarea
                                ref={logRef}
                                rows={10}
                                className="font-mono text-xs bg-black text-green-400 resize-none h-[150px] overflow-y-auto"
                                readOnly
                            />
                        </CardContent>
                    </Card>
                )}

                {/* confirmation modal ------------------------------------- */}
                <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Download Model?</DialogTitle>
                        </DialogHeader>
                        <div>
                            <p>
                                This model is approximately{' '}
                                <b>
                                    {pendingSizeMB !== null ? `${pendingSizeMB.toFixed(0)} MB` : "unknown size"}
                                </b>{' '}
                                and will be downloaded to your device for private, offline transcription.
                            </p>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShowConfirmModal(false)}>
                                Cancel
                            </Button>
                            <Button onClick={confirmDownload}>Download</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </>
    );
}
