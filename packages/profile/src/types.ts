export type Fields = Readonly<Record<string, string | number | boolean>>;
export interface Context { operationKey?: string; entityKey?: string; tick?: number; fields?: Fields }
export interface TraceWriter {
  begin(markerId: number, context?: Context): number;
  end(scopeToken: number): void;
  beginAsync?(markerId: number, context?: Context): number;
  endAsync?(asyncToken: number, context?: Context): void;
  event(markerId: number, context?: Context): void;
  link(markerId: number, correlationKey: string, side: 'out' | 'in', context?: Context): void;
}
export interface StatsWriter { add(id: number, delta: number): void; gauge(id: number, value: number): void; observe(id: number, value: number): void }
export interface ProfileHost { readonly contract: 'lumio.observation/1'; trace?: TraceWriter; stats?: StatsWriter }
export interface Marker {
  id: number; name: string; kind: 'span' | 'event' | 'link' | 'counter' | 'gauge' | 'histogram';
  category?: string; unit?: string; fields?: string[]; buckets?: number[];
  source?: { file: string; line: number }; relation?: 'queue' | 'transport' | 'causes' | 'confirms' | 'observes';
}
export interface Clock {
  id: string; epoch: string; unit: 'ms'; now(): number;
  precisionMs?: number; rawOrigin?: string; rawUnit?: string; basis?: string;
}
export interface Scheduler { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface Policy {
  allowRelease?: boolean; maxBytes?: number; maxDurationMs?: number;
  maxOpenSpans?: number; maxOpenAsyncSpans?: number; allowCpuSampling?: boolean;
}
export interface AutoCollectorsConfig {
  raf?: boolean;
  longTasks?: boolean;
  longAnimationFrames?: boolean;
  gc?: boolean;
  cpuSampling?: boolean | { sampleIntervalUs?: number };
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
  time: number; markerId: number; value: number; count: number; sum: number;
}
export interface FaultInfo {
  reason: string; captureId?: string; streamId?: string; detail?: string;
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
  host: ProfileHost; markers: Marker[]; role: string; sourceId: string;
  build: { id: string; mode: 'debug' | 'release'; codeEpoch: string };
  clock: Clock; scheduler: Scheduler; policy?: Policy; environment?: Record<string, string | number | boolean>;
  onFault?: (fault: FaultInfo) => void;
  onStateChange?: (state: { active: boolean; mode: 'off' | 'trace' | 'stats' | 'hybrid'; reason: string; captureId?: string }) => void;
  collectorAdapter?: CollectorAdapter;
}
export interface CaptureConfig {
  mode: 'trace' | 'stats' | 'hybrid'; durationMs: number; maxBytes?: number;
  overflowPolicy?: 'drop-new-detail' | 'overwrite-oldest-chunk'; markerIds?: number[];
  collectors?: AutoCollectorsConfig; statsIntervalMs?: number;
}
export interface RecordData {
  seq: number; time: number; kind: 'begin' | 'end' | 'event' | 'link'; markerId: number;
  spanId?: number; parentSpanId?: number; async?: boolean;
  correlationKey?: string; side?: 'out' | 'in'; context?: Context;
}
export interface Quality {
  dropped: number; overwritten: number; invalid: number; filtered: number;
  openSpans: number; unclosedSpans?: number; autoDropped?: number;
  tail: 'complete' | 'unknown'; reason: string;
  firstDroppedSeq?: number; lastDroppedSeq?: number; lastAttemptedSeq: number;
  detail: 'complete' | 'partial';
}
export interface StatData { markerId: number; value: number; count: number; sum: number; min: number | null; max: number | null; buckets: number[] }
export interface Snapshot {
  protocol: 'lumio.capture/1'; captureId: string; streamId: string; sourceId: string; role: string;
  build: Options['build']; clock: Omit<Clock, 'now'>; environment: Record<string, string | number | boolean>;
  config: Required<Omit<CaptureConfig, 'markerIds' | 'collectors' | 'statsIntervalMs'>> & { markerIds?: number[]; collectors?: AutoCollectorsConfig; statsIntervalMs?: number };
  startedAt: number; stoppedAt: number; allocatedBytes: number;
  markers: Marker[]; records: RecordData[]; stats: StatData[]; quality: Quality;
  autoRecords?: AutoRecordData[]; cpuProfile?: CpuProfileData; collectorStatus?: Record<string, string>; statSeries?: StatSampleData[];
}
export interface ControlChannel { subscribe(handler: (request: ControlRequest) => void): () => void; send(response: unknown): void }
export interface ControlRequest { id: string; method: 'inspect' | 'prepare' | 'start' | 'status' | 'stop' | 'snapshot' | 'drain' | 'release' | 'clock'; params?: any }
export interface ConnectOptions {
  endpoint: string;
  token: string;
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
  WebSocketImpl?: any;
  onStateChange?: (state: 'connecting' | 'connected' | 'disconnected' | 'closed', error?: unknown) => void;
}
export interface ConnectionHandle {
  readonly connected: boolean;
  readonly ready: Promise<void>;
  close(): void;
}
