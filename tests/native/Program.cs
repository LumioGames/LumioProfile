using System;
using Lumio.Profile;
class Program {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Main() {
        double now = 0; int reads = 0, fired = 0;
        var bridge = new NativeBridge(() => { reads++; return now; });
        for (int i = 0; i < 100; i++) bridge.Pump();
        Check(reads == 0, "Off pump must not read clock");
        int token = bridge.Schedule(() => fired++, 10);
        Check(token != 0, "scheduler must allocate a bounded callback token");
        now = 9; bridge.Pump(); Check(fired == 0, "not before deadline");
        now = 10; bridge.Pump(); Check(fired == 1, "deadline callback must run once");
        int after = reads; bridge.Pump(); Check(reads == after, "no idle clock");
        token = bridge.Schedule(() => fired++, 1); bridge.Cancel(token); now = 20; bridge.Pump(); Check(fired == 1, "cancel");
        for (int i = 0; i < 16; i++) Check(bridge.Schedule(() => {}, 10) != 0, "fixed slots");
        Check(bridge.Schedule(() => {}, 10) == 0, "bounded overflow");
        bridge.Dispose(); after = reads; bridge.Pump(); Check(reads == after, "disposed bridge stays idle");
        Console.WriteLine("PASS: pure .NET clock/scheduler contract. Unity/PuerTS/IL2CPP NOT validated.");
    }
}
