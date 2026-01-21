using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace PhotoLibrary.Backend;

// REQ-WFE-00024
public class RuntimeStatistics
{
    public static RuntimeStatistics Instance { get; } = new();

    private long _bytesReceived;

    private Action<object>? _onBroadcast;
    public void RegisterBroadcastHandler(Action<object> handler) => _onBroadcast = handler;

    public void RecordBytesReceived(long bytes) => Interlocked.Add(ref _bytesReceived, bytes);

    public void Start()
    {
        _ = Task.Run(async () => {
            long lastRecv = 0;
            while(true) {
                await Task.Delay(500);
                long currentRecv = Interlocked.Read(ref _bytesReceived);
                
                double recvRate = (currentRecv - lastRecv) * 2.0;

                lastRecv = currentRecv;

                // Get Memory
                var p = Process.GetCurrentProcess();
                p.Refresh();
                long memory = p.WorkingSet64;

                var stats = new {
                    type = "runtime.stats",
                    memoryBytes = memory,
                    recvBytesPerSec = recvRate
                };
                
                _onBroadcast?.Invoke(stats);
            }
        });
    }
}
