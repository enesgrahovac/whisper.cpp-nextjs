/* eslint-disable  @typescript-eslint/ban-types */
declare global {
    interface Window {
        /* simple subset – extend when you need more methods */
        Module: {
            /* exported by stream.js */
            init: (modelFile: string) => number;
            get_transcribed: () => string | null;
            get_status: () => string;
            set_audio: (instance: number, pcm: Float32Array) => void;
            set_status: (s: string) => void;

            /* FS helpers we touch from TS */
            FS_createDataFile: (
                parent: string,
                name: string,
                data: Uint8Array,
                canRead: boolean,
                canWrite: boolean
            ) => void;
            FS_unlink: (name: string) => void;

            /* misc */
            print: (...args: unknown[]) => void;
            printErr: (...args: unknown[]) => void;
        } & Record<string, unknown>;
    }

    // helper attached by the original demo – defined by our component
    const printTextarea: (msg: string) => void;
}

export { };