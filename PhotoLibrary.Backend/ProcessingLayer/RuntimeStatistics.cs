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

    private long _bytesSent;
    private long _bytesReceived;

    private Action<object>? _onBroadcast;
    public void RegisterBroadcastHandler(Action<object> handler) => _onBroadcast = handler;

    public void RecordBytesSent(long bytes) => Interlocked.Add(ref _bytesSent, bytes);
    public void RecordBytesReceived(long bytes) => Interlocked.Add(ref _bytesReceived, bytes);

    public void Start()
    {
         _ = Task.Run(async () => {
            long lastSent = 0;
            long lastRecv = 0;
            while(true) {
                 await Task.Delay(500);
                 long currentSent = Interlocked.Read(ref _bytesSent);
                 long currentRecv = Interlocked.Read(ref _bytesReceived);
                 
                 double sentRate = (currentSent - lastSent) * 2.0; 
                 double recvRate = (currentRecv - lastRecv) * 2.0;

                 lastSent = currentSent;
                 lastRecv = currentRecv;

                 // Get Memory
                 var p = Process.GetCurrentProcess();
                 p.Refresh();
                 long memory = p.WorkingSet64;

                 var stats = new {
                     type = "runtime.stats",
                     memoryBytes = memory,
                     sentBytesPerSec = sentRate,
                     recvBytesPerSec = recvRate
                                      };
                                      
                                      _onBroadcast?.Invoke(stats);
                                 }
                              });
                 
    }
}

public class TrackingStream : Stream
{
    private readonly Stream _inner;
    private readonly Action<long> _onWrite;
    public TrackingStream(Stream inner, Action<long> onWrite) { _inner = inner; _onWrite = onWrite; }
    public override bool CanRead => _inner.CanRead;
    public override bool CanSeek => _inner.CanSeek;
    public override bool CanWrite => _inner.CanWrite;
    public override long Length => _inner.Length;
    public override long Position { get => _inner.Position; set => _inner.Position = value; }
    public override void Flush() => _inner.Flush();
    public override int Read(byte[] buffer, int offset, int count)
    {
        int read = _inner.Read(buffer, offset, count);
        if (read > 0) _onWrite(read);
        return read;
    }
    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        int read = await _inner.ReadAsync(buffer, offset, count, cancellationToken);
        if (read > 0) _onWrite(read);
        return read;
    }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        int read = await _inner.ReadAsync(buffer, cancellationToken);
        if (read > 0) _onWrite(read);
        return read;
    }
    public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
    public override void SetLength(long value) => _inner.SetLength(value);
    public override void Write(byte[] buffer, int offset, int count)
    {
        _inner.Write(buffer, offset, count);
        _onWrite(count);
    }
    public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        await _inner.WriteAsync(buffer, offset, count, cancellationToken);
        _onWrite(count);
    }
    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        await _inner.WriteAsync(buffer, cancellationToken);
        _onWrite(buffer.Length);
    }
}
