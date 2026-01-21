namespace PhotoLibrary.Backend;

public class ReadTrackingStream : Stream
{
    private readonly Stream _inner;
    private readonly Action<long> _onRead;
    public ReadTrackingStream(Stream inner, Action<long> onRead) { _inner = inner; _onRead = onRead; }
    public override bool CanRead => _inner.CanRead;
    public override bool CanSeek => _inner.CanSeek;
    public override bool CanWrite => false;
    public override long Length => _inner.Length;
    public override long Position { get => _inner.Position; set => _inner.Position = value; }
    public override void Flush() => _inner.Flush();
    
    public override int Read(byte[] buffer, int offset, int count)
    {
        int read = _inner.Read(buffer, offset, count);
        if (read > 0) _onRead(read);
        return read;
    }

    public override int Read(Span<byte> buffer)
    {
        int read = _inner.Read(buffer);
        if (read > 0) _onRead(read);
        return read;
    }

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        int read = await _inner.ReadAsync(buffer, offset, count, cancellationToken);
        if (read > 0) _onRead(read);
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        int read = await _inner.ReadAsync(buffer, cancellationToken);
        if (read > 0) _onRead(read);
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
    public override void SetLength(long value) => throw new InvalidOperationException("Read-only stream.");
    
    public override void Write(byte[] buffer, int offset, int count) => throw new InvalidOperationException("Read-only stream.");
    public override void Write(ReadOnlySpan<byte> buffer) => throw new InvalidOperationException("Read-only stream.");
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => throw new InvalidOperationException("Read-only stream.");
    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Read-only stream.");
}