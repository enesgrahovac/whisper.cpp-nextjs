// next.config.ts
export default {
    async headers() {
        const security = [
            { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
            // Safari needs *require-corp*, not credentialless ↓
            { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
            // Recommended but not strictly required for same-origin assets
            { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ]
        return [{ source: "/:path*", headers: security }]
    },
}