/** Self-contained browser entry declarations with zero relative imports (safe to copy for dev-server module redirects). */

export type Fields = Readonly<Record<string, string | number | boolean>>;
export interface Context {
    operationKey?: string;
    entityKey?: string;
    tick?: number;
    fields?: Fields;
}
export interface TraceWriter {
    begin(markerId: number, context?: Context): number;
    end(scopeToken: number): void;
    beginAsync?(markerId: number, context?: Context): number;
    endAsync?(asyncToken: number, context?: Context): void;
    event(markerId: number, context?: Context): void;
    link(markerId: number, correlationKey: string, side: 'out' | 'in', context?: Context): void;
}
export interface StatsWriter {
    add(id: number, delta: number): void;
    gauge(id: number, value: number): void;
    observe(id: number, value: number): void;
}
export interface ProfileHost {
    readonly contract: 'lumio.observation/1';
    trace?: TraceWriter;
    stats?: StatsWriter;
}
export interface Marker {
    id: number;
    name: string;
    kind: 'span' | 'event' | 'link' | 'counter' | 'gauge' | 'histogram';
    category?: string;
    unit?: string;
    fields?: string[];
    buckets?: number[];
    source?: {
        file: string;
        line: number;
    };
    relation?: 'queue' | 'transport' | 'causes' | 'confirms' | 'observes';
}
export interface Clock {
    id: string;
    epoch: string;
    unit: 'ms';
    now(): number;
    precisionMs?: number;
    rawOrigin?: string;
    rawUnit?: string;
    basis?: string;
}
export interface Scheduler {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
export interface Policy {
    allowRelease?: boolean;
    maxBytes?: number;
    maxDurationMs?: number;
    maxOpenSpans?: number;
    maxOpenAsyncSpans?: number;
    allowCpuSampling?: boolean;
}
export interface AutoCollectorsConfig {
    raf?: boolean;
    longTasks?: boolean;
    longAnimationFrames?: boolean;
    gc?: boolean;
    cpuSampling?: boolean | {
        sampleIntervalUs?: number;
    };
}
export interface AutoRecordData {
    kind: 'raf' | 'longtask' | 'long-animation-frame' | 'gc';
    name: string;
    startTime: number;
    durationMs: number;
    fields?: Fields;
}
export interface CpuProfileNode {
    id: number;
    functionName: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    parentId?: number;
    children?: number[];
    hitCount?: number;
}
export interface CpuProfileData {
    collector: 'node-inspector-v8' | 'browser-js-self-profiling';
    timeBasis: string;
    sampleIntervalUs: number;
    startedAt: number;
    stoppedAt: number;
    nodes: CpuProfileNode[];
    samples: number[];
    timestampsMs: number[];
    rawV8Profile?: unknown;
}
export interface StatSampleData {
    time: number;
    markerId: number;
    value: number;
    count: number;
    sum: number;
}
export interface FaultInfo {
    reason: string;
    captureId?: string;
    streamId?: string;
    detail?: string;
}
export interface CollectorStopResult {
    autoRecords?: AutoRecordData[];
    cpuProfile?: CpuProfileData;
    status: Record<string, string>;
    autoDropped?: number;
}
export interface CollectorSessionHandle {
    stop(): CollectorStopResult | Promise<CollectorStopResult>;
}
export interface CollectorAdapter {
    capabilities: Record<string, boolean>;
    start(config: AutoCollectorsConfig, policy: Policy): CollectorSessionHandle;
}
export interface Options {
    host: ProfileHost;
    markers: Marker[];
    role: string;
    sourceId: string;
    build: {
        id: string;
        mode: 'debug' | 'release';
        codeEpoch: string;
    };
    clock: Clock;
    scheduler: Scheduler;
    policy?: Policy;
    environment?: Record<string, string | number | boolean>;
    onFault?: (fault: FaultInfo) => void;
    onStateChange?: (state: {
        active: boolean;
        mode: 'off' | 'trace' | 'stats' | 'hybrid';
        reason: string;
        captureId?: string;
    }) => void;
    collectorAdapter?: CollectorAdapter;
}
export interface CaptureConfig {
    mode: 'trace' | 'stats' | 'hybrid';
    durationMs: number;
    maxBytes?: number;
    overflowPolicy?: 'drop-new-detail' | 'overwrite-oldest-chunk';
    markerIds?: number[];
    collectors?: AutoCollectorsConfig;
    statsIntervalMs?: number;
}
export interface RecordData {
    seq: number;
    time: number;
    kind: 'begin' | 'end' | 'event' | 'link';
    markerId: number;
    spanId?: number;
    parentSpanId?: number;
    async?: boolean;
    correlationKey?: string;
    side?: 'out' | 'in';
    context?: Context;
}
export interface Quality {
    dropped: number;
    overwritten: number;
    invalid: number;
    filtered: number;
    openSpans: number;
    unclosedSpans?: number;
    autoDropped?: number;
    tail: 'complete' | 'unknown';
    reason: string;
    firstDroppedSeq?: number;
    lastDroppedSeq?: number;
    lastAttemptedSeq: number;
    detail: 'complete' | 'partial';
}
export interface StatData {
    markerId: number;
    value: number;
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
    buckets: number[];
}
export interface Snapshot {
    protocol: 'lumio.capture/1';
    captureId: string;
    streamId: string;
    sourceId: string;
    role: string;
    build: Options['build'];
    clock: Omit<Clock, 'now'>;
    environment: Record<string, string | number | boolean>;
    config: Required<Omit<CaptureConfig, 'markerIds' | 'collectors' | 'statsIntervalMs'>> & {
        markerIds?: number[];
        collectors?: AutoCollectorsConfig;
        statsIntervalMs?: number;
    };
    startedAt: number;
    stoppedAt: number;
    allocatedBytes: number;
    markers: Marker[];
    records: RecordData[];
    stats: StatData[];
    quality: Quality;
    autoRecords?: AutoRecordData[];
    cpuProfile?: CpuProfileData;
    collectorStatus?: Record<string, string>;
    statSeries?: StatSampleData[];
}
export interface ControlChannel {
    subscribe(handler: (request: ControlRequest) => void): () => void;
    send(response: unknown): void;
}
export interface ControlRequest {
    id: string;
    method: 'inspect' | 'prepare' | 'start' | 'status' | 'stop' | 'snapshot' | 'drain' | 'release' | 'clock';
    params?: any;
}
export interface ConnectOptions {
    endpoint: string;
    token: string;
    reconnect?: boolean | {
        initialDelayMs?: number;
        maxDelayMs?: number;
    };
    WebSocketImpl?: any;
    onStateChange?: (state: 'connecting' | 'connected' | 'disconnected' | 'closed', error?: unknown) => void;
}
export interface ConnectionHandle {
    readonly connected: boolean;
    readonly ready: Promise<void>;
    close(): void;
}

/** Adapts an already opened, host-owned socket. Does not create connections. */
export declare function websocketChannel(socket: {
    readyState: number;
    bufferedAmount: number;
    send(data: string): void;
    addEventListener(type: string, callback: any): void;
    removeEventListener(type: string, callback: any): void;
}, maxMessageBytes?: number, maxBufferedBytes?: number): ControlChannel;
/** Adapts a Web or Node MessagePort / DedicatedWorkerGlobalScope for forwarding control without Worker WebSockets. */
export declare function messagePortChannel(port: {
    postMessage(message: unknown): void;
    start?(): void;
    addEventListener?(type: string, listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener?(type: string, listener: (event: {
        data: unknown;
    }) => void): void;
    on?(event: string, listener: (value: unknown) => void): void;
    off?(event: string, listener: (value: unknown) => void): void;
}, maxMessageBytes?: number): ControlChannel;
export interface ConnectableProfiler {
    inspect(): unknown;
    attachControl(channel: ControlChannel): () => void;
}
/**
 * Connects a profiler to the local control service, sending the token in the initial
 * handshake frame rather than the WebSocket URL query string, with optional auto-reconnect
 * and clean disposal.
 */
export declare function connect(profiler: ConnectableProfiler, options: ConnectOptions): ConnectionHandle;
export declare function connect(options: ConnectOptions & {
    profiler: ConnectableProfiler;
}): ConnectionHandle;

/** Deduplicates or merges multiple marker catalogs (e.g. Engine + Game markers), rejecting ID collisions with mismatched definitions. */
export declare function mergeMarkers(...catalogs: readonly (readonly Marker[])[]): Marker[];
export declare function createProfiler(options: Options): {
    validationErrors: string[];
    inspect: () => {
        protocol: string;
        sourceId: string;
        role: string;
        build: {
            id: string;
            mode: "debug" | "release";
            codeEpoch: string;
        };
        supported: boolean;
        validationErrors: string[];
        invalidReason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        mode: string | undefined;
        environment: {
            clockResolutionMs?: number | undefined;
        };
        capabilities: {
            stats: boolean;
            trace: boolean;
            hybrid: boolean;
            asyncSpans: boolean;
            drain: boolean;
            nativeCpu: boolean;
            gpu: boolean;
            physicalPresent: boolean;
        };
        policy: {
            allowRelease?: boolean;
            maxBytes: number;
            maxDurationMs: number;
            maxOpenSpans: number;
            maxOpenAsyncSpans?: number;
            allowCpuSampling: boolean;
        };
    };
    prepare: (input: CaptureConfig) => {
        ok: false;
        error: string;
        reasons: string[];
        token?: undefined;
        config?: undefined;
    } | {
        ok: false;
        error: string;
        reasons?: undefined;
        token?: undefined;
        config?: undefined;
    } | {
        ok: true;
        token: string;
        config: Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        };
        error?: undefined;
        reasons?: undefined;
    };
    start: (input: {
        token: string;
        requestId: string;
        captureId: string;
    }) => any;
    stop: (reason?: string) => {
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    };
    stopAsync: (reason?: string) => Promise<{
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    }>;
    status: () => {
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    };
    snapshot: (offset?: number, limit?: number) => Snapshot & {
        window: {
            offset: number;
            total: number;
            next: number | null;
        };
    };
    drain: (ackSeq?: number, limit?: number) => {
        ok: true;
        captureId: string;
        streamId: string;
        active: boolean;
        records: RecordData[];
        lastSeq: number;
        remaining: number;
    };
    release: () => {
        ok: boolean;
        error: string;
    } | {
        ok: boolean;
        error?: undefined;
    };
    readClock: () => {
        ok: boolean;
        error: string;
        clockId?: undefined;
        clockEpoch?: undefined;
        precisionMs?: undefined;
        time?: undefined;
    } | {
        ok: boolean;
        clockId: string;
        clockEpoch: string;
        precisionMs: number | undefined;
        time: number;
        error?: undefined;
    };
    attachControl: (channel: ControlChannel) => () => void;
    connect(connectOptions: ConnectOptions): ConnectionHandle;
};

export type BrowserOptions = Omit<Options, 'clock' | 'scheduler' | 'sourceId' | 'collectorAdapter'> & {
    sourceId?: string;
};
export declare function createBrowserProfiler(options: BrowserOptions): {
    validationErrors: string[];
    inspect: () => {
        protocol: string;
        sourceId: string;
        role: string;
        build: {
            id: string;
            mode: "debug" | "release";
            codeEpoch: string;
        };
        supported: boolean;
        validationErrors: string[];
        invalidReason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        mode: string | undefined;
        environment: {
            clockResolutionMs?: number | undefined;
        };
        capabilities: {
            stats: boolean;
            trace: boolean;
            hybrid: boolean;
            asyncSpans: boolean;
            drain: boolean;
            nativeCpu: boolean;
            gpu: boolean;
            physicalPresent: boolean;
        };
        policy: {
            allowRelease?: boolean;
            maxBytes: number;
            maxDurationMs: number;
            maxOpenSpans: number;
            maxOpenAsyncSpans?: number;
            allowCpuSampling: boolean;
        };
    };
    prepare: (input: CaptureConfig) => {
        ok: false;
        error: string;
        reasons: string[];
        token?: undefined;
        config?: undefined;
    } | {
        ok: false;
        error: string;
        reasons?: undefined;
        token?: undefined;
        config?: undefined;
    } | {
        ok: true;
        token: string;
        config: Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        };
        error?: undefined;
        reasons?: undefined;
    };
    start: (input: {
        token: string;
        requestId: string;
        captureId: string;
    }) => any;
    stop: (reason?: string) => {
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    };
    stopAsync: (reason?: string) => Promise<{
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    }>;
    status: () => {
        sourceId: string;
        active: boolean;
        mode: string | undefined;
        captureId: string | undefined;
        streamId: string | undefined;
        capacity: number;
        allocatedBytes: number;
        retainedRecords: number;
        stats: {
            buckets: number[];
            markerId: number;
            value: number;
            count: number;
            sum: number;
            min: number | null;
            max: number | null;
        }[] | undefined;
        reason: string;
        lastFault: {
            reason: string;
            captureId?: string;
            streamId?: string;
            detail?: string;
        } | undefined;
        config: (Required<Omit<CaptureConfig, "markerIds" | "collectors" | "statsIntervalMs">> & {
            markerIds?: number[];
            collectors?: AutoCollectorsConfig;
            statsIntervalMs?: number;
        }) | undefined;
        quality: {
            dropped: number;
            overwritten: number;
            invalid: number;
            filtered: number;
            openSpans: number;
            unclosedSpans?: number;
            autoDropped?: number;
            tail: "complete" | "unknown";
            reason: string;
            firstDroppedSeq?: number;
            lastDroppedSeq?: number;
            lastAttemptedSeq: number;
            detail: "complete" | "partial";
        } | undefined;
    };
    snapshot: (offset?: number, limit?: number) => Snapshot & {
        window: {
            offset: number;
            total: number;
            next: number | null;
        };
    };
    drain: (ackSeq?: number, limit?: number) => {
        ok: true;
        captureId: string;
        streamId: string;
        active: boolean;
        records: RecordData[];
        lastSeq: number;
        remaining: number;
    };
    release: () => {
        ok: boolean;
        error: string;
    } | {
        ok: boolean;
        error?: undefined;
    };
    readClock: () => {
        ok: boolean;
        error: string;
        clockId?: undefined;
        clockEpoch?: undefined;
        precisionMs?: undefined;
        time?: undefined;
    } | {
        ok: boolean;
        clockId: string;
        clockEpoch: string;
        precisionMs: number | undefined;
        time: number;
        error?: undefined;
    };
    attachControl: (channel: ControlChannel) => () => void;
    connect(connectOptions: ConnectOptions): ConnectionHandle;
};

