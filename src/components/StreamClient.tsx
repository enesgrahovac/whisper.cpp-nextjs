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

    /* pre-bootstrap a dummy Module object --------------------------- */
    useEffect(() => {
        window.Module = {
            print: log,
            printErr: log,

            onRuntimeInitialized() {
                log('js: WASM runtime initialised 👍');

                /* ----- HOT-PATCH: export the heap if Emscripten didn't do it ----- */
                if (typeof (window.Module as any).HEAPU8 === 'undefined' &&
                    (window.Module as any).wasmMemory) {
                    (window.Module as any).HEAPU8 =
                        new Uint8Array((window.Module as any).wasmMemory.buffer);
                }
                /* ---------------------------------------------------------------- */

                setWasmReady(true);
            },
        } as any;
    }, [log]);

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
        } catch (error) {
            log(`js: failed to clear cache: ${error}`);
        }
    };

    const fetchWithProgress = async (
        url: string,
        cb: (pct: number) => void
    ): Promise<Uint8Array> => {
        const r = await fetch(url);
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
        /* concat */
        const out = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) {
            out.set(c, pos);
            pos += c.length;
        }
        return out;
    };

    /* ---------- model loader -------------------------------------- */
    const loadModel = async (id: ModelId) => {
        setReady(false);
        setPct(null);
        log(`js: loading model "${id}" …`);

        // Wait until the runtime exists – otherwise FS_* helpers are not there
        if (!wasmReady) {
            log('js: waiting for WASM runtime …');
            await new Promise<void>(ok => {
                const t = setInterval(() => {
                    if (wasmReady) { clearInterval(t); ok(); }
                }, 50);
            });
        }

        const cached = await getCached(id);
        if (cached) {
            log(`js: using cached copy (${(cached.length / 1_048_576).toFixed(1)} MB)`);
            writeModelToFS(cached);
            setReady(true);
            return;
        }

        try {
            const bytes = await fetchWithProgress(MODELS[id].url, setPct);
            setPct(1);
            writeModelToFS(bytes);
            await putCached(id, bytes);
            log('js: model cached');
            setReady(true);
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

    return (
        <div className="container mx-auto px-4 py-8 max-w-4xl">
            <Script src="/whisper/stream/helpers.js" strategy="afterInteractive" />
            <Script src="/whisper/stream/stream.js" strategy="afterInteractive" />

            <h1 className="text-3xl font-bold mb-8 text-center">
                Whisper.wasm - Real-time Speech Recognition
            </h1>

            <h2 className="text-2xl font-bold mb-4 text-center">
                Built with Next.js, Typescript, and Shadcn/UI
            </h2>

            <Card className="mb-8">
                <CardHeader>
                    <CardTitle>Select Model</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        {(Object.keys(MODELS) as ModelId[]).map(id => (
                            <Button
                                key={id}
                                variant={ready && downloadPct === 1 ? "secondary" : "outline"}
                                onClick={() => loadModel(id)}
                                disabled={downloadPct !== null && downloadPct < 1}
                                className="w-full"
                            >
                                {id} ({MODELS[id].sizeMB} MB)
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
        </div>
    );
}