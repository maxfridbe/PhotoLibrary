namespace PhotoLibrary
{
    public record IdRequest(string id);
    public record NameRequest(string name);
    public record PickRequest(string id, bool isPicked);
    public record RateRequest(string id, int rating);
    public record SearchRequest(string tag, string value);
    public record CollectionAddRequest(string collectionId, string[] fileIds);
    public record PagedPhotosRequest(int? limit, int? offset, string? rootId, bool? pickedOnly, int? rating, string[]? specificIds);
    
    // WebSocket request
    public class ImageRequest 
    { 
        public int requestId { get; set; } 
        public string fileId { get; set; } = ""; 
        public int size { get; set; } 
    }
}
