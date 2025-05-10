/** @type {import('next').NextConfig} */
const nextConfig = {
    async headers() {
        const security = [
            { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            // use *one* of the next two lines ──────────────────────────────
            // { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
            { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ];

        return [
            {
                source: '/:path*',       // apply to every route and static file
                headers: security,
            },
        ];
    },
};

export default nextConfig;