#if LUMIO_PROFILE
using System;
using System.Diagnostics;
namespace Lumio.Profile {
    // The host calls Pump on its JS/Unity thread. Never invokes PuerTS callbacks
    // from a System.Threading.Timer. No Unity scene objects are created implicitly.
    public sealed class NativeBridge : IDisposable {
        readonly Func<double> clock;
        readonly Action[] callbacks = new Action[16];
        readonly double[] due = new double[16];
        readonly int[] tokens = new int[16];
        int count, sequence;
        bool disposed;
        long origin;
        bool hasOrigin;
        public string SourceId { get; } = Guid.NewGuid().ToString("N");
        public string ClockId { get; } = Guid.NewGuid().ToString("N");
        public string ClockEpoch { get; } = "1";
        public long Frequency => Stopwatch.Frequency;
        public NativeBridge(Func<double> clock = null) { this.clock = clock ?? ReadMonotonic; }
        double ReadMonotonic() {
            long stamp = Stopwatch.GetTimestamp();
            if (!hasOrigin) { origin = stamp; hasOrigin = true; }
            return (stamp - origin) * (1000.0 / Stopwatch.Frequency);
        }
        public double NowMilliseconds() { if (disposed) throw new ObjectDisposedException(nameof(NativeBridge)); return clock(); }
        public int Schedule(Action callback, double delayMs) {
            if (disposed || callback == null || count == 16 || sequence == int.MaxValue || double.IsNaN(delayMs) || delayMs < 0 || delayMs > 60000) return 0;
            for (int i = 0; i < 16; i++) if (callbacks[i] == null) {
                int token = ++sequence; due[i] = clock() + delayMs; tokens[i] = token; callbacks[i] = callback; count++; return token;
            }
            return 0;
        }
        public void Cancel(int token) {
            for (int i = 0; i < 16; i++) if (tokens[i] == token && callbacks[i] != null) { callbacks[i] = null; count--; return; }
        }
        public void Pump() {
            if (disposed || count == 0) return;
            double now = clock(); int cutoff = sequence;
            for (int i = 0; i < 16; i++) if (callbacks[i] != null && tokens[i] <= cutoff && due[i] <= now) {
                Action callback = callbacks[i]; callbacks[i] = null; count--;
                try { callback(); } catch { /* Diagnostic failure must not escape into host update. */ }
            }
        }
        public void Dispose() { disposed = true; Array.Clear(callbacks, 0, callbacks.Length); count = 0; }
    }
}
#endif
