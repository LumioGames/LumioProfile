export type Fields = Readonly<Record<string, string | number | boolean>>;
export interface Context { operationKey?: string; entityKey?: string; tick?: number; fields?: Fields }
export interface TraceWriter {
  begin(markerId: number, context?: Context): number;
  end(scopeToken: number): void;
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
export interface Policy { allowRelease?: boolean; maxBytes?: number; maxDurationMs?: number; maxOpenSpans?: number }
export interface Options {
  host: ProfileHost; markers: Marker[]; role: string; sourceId: string;
  build: { id: string; mode: 'debug' | 'release'; codeEpoch: string };
  clock: Clock; scheduler: Scheduler; policy?: Policy; environment?: Record<string, string | number | boolean>;
}
export interface CaptureConfig {
  mode: 'trace' | 'stats'; durationMs: number; maxBytes?: number;
  overflowPolicy?: 'drop-new-detail' | 'overwrite-oldest-chunk'; markerIds?: number[];
}
export interface RecordData {
  seq: number; time: number; kind: 'begin' | 'end' | 'event' | 'link'; markerId: number;
  spanId?: number; parentSpanId?: number; correlationKey?: string; side?: 'out' | 'in'; context?: Context;
}
export interface Quality {
  dropped: number; overwritten: number; invalid: number; filtered: number;
  openSpans: number; tail: 'complete' | 'unknown'; reason: string;
  firstDroppedSeq?: number; lastDroppedSeq?: number; lastAttemptedSeq: number;
  detail: 'complete' | 'partial';
}
export interface StatData { markerId: number; value: number; count: number; sum: number; min: number | null; max: number | null; buckets: number[] }
export interface Snapshot {
  protocol: 'lumio.capture/1'; captureId: string; streamId: string; sourceId: string; role: string;
  build: Options['build']; clock: Omit<Clock, 'now'>; environment: Record<string, string | number | boolean>;
  config: Required<Omit<CaptureConfig, 'markerIds'>> & { markerIds?: number[] };
  startedAt: number; stoppedAt: number; allocatedBytes: number;
  markers: Marker[]; records: RecordData[]; stats: StatData[]; quality: Quality;
}
export interface ControlChannel { subscribe(handler: (request: ControlRequest) => void): () => void; send(response: unknown): void }
export interface ControlRequest { id: string; method: 'inspect' | 'prepare' | 'start' | 'status' | 'stop' | 'snapshot' | 'release' | 'clock'; params?: any }
