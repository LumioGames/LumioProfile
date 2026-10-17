/** Copy this dependency-free contract into the host; ordinary builds never import the plugin. */
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
