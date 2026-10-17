# Optional native bridge — runtime validation pending

This package contains only a monotonic clock and a 16-slot main-thread deadline scheduler. It does not start Unity Profiler, capture GPU data, create GameObjects, open sockets or instrument gameplay.

The assembly requires the explicit `LUMIO_PROFILE` scripting symbol and is not auto-referenced. Both Debug and retained Release must explicitly install/attach and start collection. Ordinary builds should exclude this package and the diagnostic JS entry entirely.

Create `Lumio.Profile.NativeBridge` from the optional host entry, supply the wrapper shown in `examples/puerts/attach.ts`, and call `Pump()` from the host's main-thread update only while the bridge exists. Idle `Pump()` does not read the clock. Cancelled or disposed callbacks never run. If Unity stops updating, deadlines are processed on resume; event writes also enforce deadlines using the source clock.

Only the pure C# clock/scheduler contract is tested on .NET 10. No Unity Editor/Player, PuerTS binding, delegate marshaling, Mono, IL2CPP or native overhead validation has been performed. The package manifest version is a compatibility target, not a tested support claim. Host-owned transport and PuerTS binding configuration remain explicit integration steps.
