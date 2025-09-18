using System.ComponentModel.DataAnnotations;


namespace Backend.Models
{
    public class AppUser
    {
        [Key] public Guid Id { get; set; } = Guid.NewGuid();
        [Required] public string Nickname { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }


    public class Presentation
    {
        [Key] public Guid Id { get; set; } = Guid.NewGuid();
        [Required] public string Title { get; set; } = string.Empty;
        [Required] public string Slug { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }


    public class Membership
    {
        public Guid PresentationId { get; set; }
        public Guid UserId { get; set; }
        [Required] public string Role { get; set; } = "viewer"; // creator, editor, viewer
        [Required] public string Nickname { get; set; } = string.Empty; // denormalized for unique index
    }


    public class Slide
    {
        [Key] public Guid Id { get; set; } = Guid.NewGuid();
        [Required] public Guid PresentationId { get; set; }
        [Required] public int Position { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }


    public class Element
    {
        [Key] public Guid Id { get; set; } = Guid.NewGuid();
        [Required] public Guid SlideId { get; set; }
        [Required] public string Kind { get; set; } = "text"; // text, rect, circle, arrow, image
        [Required] public decimal X { get; set; }
        [Required] public decimal Y { get; set; }
        [Required] public decimal W { get; set; }
        [Required] public decimal H { get; set; }
        [Required] public int Z { get; set; } = 0;
        [Required] public string Props { get; set; } = "{}"; // JSON string for simplicity
        public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    }


    public class OpLog
    {
        [Key] public long Id { get; set; }
        [Required] public Guid PresentationId { get; set; }
        [Required] public Guid UserId { get; set; }
        public Guid? SlideId { get; set; }
        public Guid? ElementId { get; set; }
        [Required] public string OpType { get; set; } = "";
        [Required] public string Payload { get; set; } = "{}";
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }
}