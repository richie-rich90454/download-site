export interface UpdaterResult {
    status: number;
    body: unknown;
    contentType?: string;
}

export interface UpdaterContext {
    appId: string;
    currentVersion?: string;
    target?: string;
    platformHint?: string;
}

export interface TauriV1Manifest {
    version: string;
    notes: string;
    pub_date: string;
    signature: string;
    url: string;
}

export interface TauriV2Manifest {
    version: string;
    notes: string;
    pub_date: string;
    platforms: Record<string, { signature: string; url: string }>;
}

export interface GenericUpdateManifest {
    version: string;
    notes: string;
    pubDate: string;
    platforms: Record<string, { signature: string; url: string }>;
}

export interface SquirrelManifest {
    url: string;
    name?: string;
    notes?: string;
    pub_date?: string;
}
