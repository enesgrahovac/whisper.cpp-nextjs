'use client';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * <ModelSelector> — catalogue picker for ggml Whisper models
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Pure-UI component: it only renders a list of models and emits the user's
 * choice.  All networking, caching, WASM FS mounting, etc. live in
 * <StreamClient>;  <ModelSelector> remains 100 % presentational.
 *
 * Props
 * -----
 * grouped       Record<string, ModelMeta[]>
 *               Models bucketed by `version` (tiny, base, …).
 *
 * fetchError    string | null
 *               Optional error message from the catalogue fetch request.
 *
 * selectedId    string | null
 *               ID (filename) of the model that is currently loaded.
 *
 * onSelect      (id: string) → void
 *               Invoked when the user clicks a variant.
 *
 * downloadPct   number | null
 *               Download progress in the range 0 – 1 (null = not downloading).
 *
 * ready         boolean
 *               True once the selected model is mounted in the WASM FS.
 *
 * onClearCache  () → void
 *               Clears the IndexedDB model cache.
 *
 * ModelMeta
 * ---------
 * Mirrors the structure assembled in StreamClient; reproduced here so the
 * selector can stay decoupled from data-fetch / WASM details.
 * ────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';

/* ─────────────── types ─────────────────────────────────────────────── */
export interface ModelMeta {
    id: string;                 // ggml-*.bin filename
    url: string;                // absolute download URL
    sizeMB: number | null;      // approximate size (via HEAD) or null if unknown
    version: string;            // tiny | base | ...
    rev?: string | null;        // v1 | v2 | v3 (large models)
    variant?: string | null;    // turbo | fp16 | ...
    lang: 'en' | 'multi';       // .en suffix → 'en'
    quant: string | null;       // q8_0 | q5_1 | ...
}

export interface ModelSelectorProps {
    grouped: Record<string, ModelMeta[]>;
    fetchError: string | null;
    selectedId: string | null;
    onSelect(id: string): void;
    downloadPct: number | null;   // e.g. 0.37 → 37 %
    ready: boolean;               // model mounted in the FS
    onClearCache(): void;         // handler for "Clear cache" button
}

/* ─────────────── constants ─────────────────────────────────────────── */
const quantTooltip: Record<string, string> = {
    q8_0:
        "q8_0 – 8-bit: ≈ 50–55 % of FP16, virtually lossless.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q6_K:
        "6-bit K-quant (q6_K): ≈ 98–99 % accuracy, ~40 % of original size.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q5_1:
        "5-bit K-quant (q5_1): ≈ 96–98 % accuracy, ~35 % size.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q5_0:
        "5-bit legacy (q5_0): older method, slightly less accurate.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q4_1:
        "4-bit improved (q4_1): ≈ 93–96 % accuracy, ~25–30 % size.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q4_0:
        "4-bit legacy (q4_0): noticeable drop in accuracy.\n" +
        "Quantization reduces model size by lowering weight precision.",
    q3:
        "3-bit (q3): experimental; sharp WER increase (~20 % size).\n" +
        "Quantization reduces model size by lowering weight precision.",
    q2:
        "2-bit (q2): proof of concept only (~15 % size).\n" +
        "Quantization reduces model size by lowering weight precision."
};

/* --------------------------------------- tool-tips -------------- */
const langTooltip: Record<"en" | "multi", string> = {
    en: "Monolingual – vocabulary reduced to English (≈30 % faster, smaller).",
    multi: "Full multilingual vocabulary.",
}

const variantTooltip: Record<string, string> = {
    turbo:
        "Turbo variant – matrices re-ordered for faster GEMM.\n" +
        "Expect ~25-40 % higher throughput at the cost of a small WER increase.",
    /* add more variants here when they appear (fp16, int8 …) */
}

/* small helper ---------------------------------------------------- */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const formatSize = (sizeMB: number | null) => {
    if (sizeMB === null) return "-";
    if (sizeMB >= 1000) return `${(sizeMB / 1024).toFixed(1)} GB`;
    return `${sizeMB.toFixed(0)} MB`;
};

/* ------------------------------------------------------------------
   component
------------------------------------------------------------------ */
const ModelSelector: React.FC<ModelSelectorProps> = React.memo(
    ({
        grouped,
        fetchError,
        selectedId,
        onSelect,
        downloadPct,
        ready,
        onClearCache,
    }) => {
        // Disable actions while downloading
        const isDownloading = downloadPct !== null && downloadPct < 1;

        // Handler to clear cache and reset selection/status
        const handleClearCache = () => {
            onClearCache();
        };

        return (
            <Card className="mb-8">
                <CardHeader>
                    <CardTitle>Select Model</CardTitle>
                </CardHeader>
                <CardContent>
                    {fetchError && (
                        <p className="text-destructive mb-4 text-sm">
                            ⚠️ Could not fetch catalogue – using fallback list. ({fetchError})
                        </p>
                    )}
                    <Accordion type="single" collapsible>
                        {Object.entries(grouped).map(([version, list]) => {
                            // Find the selected model in this group, if any
                            const selectedModel = list.find((m) => m.id === selectedId);
                            return (
                                <AccordionItem value={version} key={version}>
                                    <AccordionTrigger>
                                        <div className="flex items-center gap-2">
                                            <span className="capitalize">{version}</span>
                                            <Badge variant="secondary">{list.length} variants</Badge>
                                            {selectedModel && (
                                                <Badge variant="success">
                                                    Selected
                                                </Badge>
                                            )}
                                        </div>
                                    </AccordionTrigger>
                                    <AccordionContent>
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                            {list.map((m) => {
                                                const isActive = selectedId === m.id;

                                                /* ----- first-line label -------------------------------------- */
                                                const labelParts = [
                                                    cap(m.version),            // Large
                                                    m.rev?.toUpperCase(),      // V3
                                                    m.variant ? cap(m.variant) : null, // Turbo (if any)
                                                ].filter(Boolean)

                                                const display = labelParts.join(" ") + (m.lang === "en" ? ".en" : "")

                                                /* ----- combine the 2 (or 1) tool-tips ------------------------ */
                                                const tooltipText = [
                                                    langTooltip[m.lang],
                                                    m.variant ? variantTooltip[m.variant] ?? `Variant: ${m.variant}` : null,
                                                ]
                                                    .filter(Boolean)
                                                    .join("\n\n") // blank line between paragraphs

                                                return (
                                                    <Button
                                                        key={m.id}
                                                        variant={isActive ? 'default' : 'outline'}
                                                        className="flex flex-col items-start justify-center px-3 py-2 min-h-[56px]"
                                                        onClick={() => onSelect(m.id)}
                                                        disabled={isDownloading}
                                                    >
                                                        <Tooltip>
                                                            <TooltipTrigger asChild>
                                                                <span className="font-semibold text-left">
                                                                    {display}
                                                                    {isActive && <span className="ml-1">✅</span>}
                                                                </span>
                                                            </TooltipTrigger>
                                                            <TooltipContent className="max-w-xs whitespace-pre-wrap">
                                                                {tooltipText}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                        <div className="flex items-center gap-1 w-full text-sm text-muted-foreground">
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <span className="underline decoration-dotted">
                                                                        {m.quant ?? "full model"}
                                                                    </span>
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    {(() => {
                                                                        const tooltip = m.quant ? quantTooltip[m.quant] : "Un-quantised FP16 weights";
                                                                        const [firstLine, ...rest] = tooltip.split('\n');
                                                                        return (
                                                                            <>
                                                                                <span>{firstLine}</span>
                                                                                {rest.length > 0 && (
                                                                                    <div className="text-xs text-muted-foreground mt-2">
                                                                                        {rest.map((line, i) => (
                                                                                            <React.Fragment key={i}>
                                                                                                {line}
                                                                                                <br />
                                                                                            </React.Fragment>
                                                                                        ))}
                                                                                    </div>
                                                                                )}
                                                                            </>
                                                                        );
                                                                    })()}
                                                                </TooltipContent>
                                                            </Tooltip>
                                                            <span className="ml-auto">
                                                                {formatSize(m.sizeMB)}
                                                            </span>
                                                        </div>
                                                    </Button>
                                                );
                                            })}
                                        </div>
                                    </AccordionContent>
                                </AccordionItem>
                            );
                        })}
                    </Accordion>

                    {/* ---------------- Model-status area --------------------------- */}
                    <div className="mt-6 space-y-4">
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
                                    {ready
                                        ? "Ready"
                                        : downloadPct !== null
                                            ? "Downloading"
                                            : "Idle"}
                                </Badge>
                            </div>
                            <Button
                                variant="outline"
                                onClick={handleClearCache}
                                disabled={isDownloading}
                            >
                                Clear Cache
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        );
    }
);
ModelSelector.displayName = 'ModelSelector';
export default ModelSelector;
