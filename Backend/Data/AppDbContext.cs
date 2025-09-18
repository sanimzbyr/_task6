using Microsoft.EntityFrameworkCore;
using Backend.Models;


namespace Backend.Data
{
    public class AppDbContext : DbContext
    {
        public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }


        public DbSet<Presentation> Presentations => Set<Presentation>();
        public DbSet<Slide> Slides => Set<Slide>();
        public DbSet<Element> Elements => Set<Element>();
        public DbSet<AppUser> Users => Set<AppUser>();
        public DbSet<Membership> Memberships => Set<Membership>();
        public DbSet<OpLog> OpLogs => Set<OpLog>();


        protected override void OnModelCreating(ModelBuilder b)
        {
            b.HasPostgresExtension("pgcrypto");


            b.Entity<Presentation>(e =>
            {
                e.HasKey(x => x.Id);
                e.HasIndex(x => x.Slug).IsUnique();
            });


            b.Entity<Slide>(e =>
            {
                e.HasKey(x => x.Id);
                e.HasIndex(x => new { x.PresentationId, x.Position });
            });


            b.Entity<Element>(e =>
            {
                e.HasKey(x => x.Id);
                e.HasIndex(x => x.SlideId);
                e.HasIndex(x => x.UpdatedAt);
            });


            b.Entity<AppUser>(e =>
            {
                e.HasKey(x => x.Id);
            });


            b.Entity<Membership>(e =>
            {
                e.HasKey(x => new { x.PresentationId, x.UserId });
                e.HasIndex(x => new { x.PresentationId, x.Nickname }).IsUnique();
            });


            b.Entity<OpLog>(e =>
            {
                e.HasKey(x => x.Id);
                e.HasIndex(x => new { x.PresentationId, x.CreatedAt });
            });
        }
    }
}