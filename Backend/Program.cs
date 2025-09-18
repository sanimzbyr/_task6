// Minimal API + SignalR + EFCore (Postgres)
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using Backend.Data;
using Backend.Hubs;
using Backend.Models;
using Microsoft.AspNetCore.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;


var builder = WebApplication.CreateBuilder(args);


// Allow Vite dev (5173) and any origin override via env
var allowOrigins = builder.Configuration.GetValue<string>("Cors:Origins") ?? "http://localhost:5173";


// Keep property names as declared (PascalCase)
builder.Services.Configure<JsonOptions>(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = null;
});


builder.Services.AddDbContext<AppDbContext>(opt =>
{
    var cs =
        builder.Configuration.GetConnectionString("Postgres")
        ?? builder.Configuration["ConnectionStrings:Postgres"]
        ?? "Host=localhost;Port=5432;Database=_task6_;Username=postgres;Password=3.14159";

    opt.UseNpgsql(cs);
});


builder.Services.AddSignalR(o =>
{
    o.EnableDetailedErrors = true;
});


builder.Services.AddCors(o =>
{
    o.AddDefaultPolicy(p => p
        .WithOrigins(allowOrigins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());
});

var app = builder.Build();


app.UseCors();
app.UseStaticFiles(); // serves wwwroot (for uploads)


// Ensure database exists and apply migrations
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}


app.MapHub<PresoHub>("/hubs/preso");


// Helpers
static string Slugify(string input)
{
    if (string.IsNullOrWhiteSpace(input)) return Guid.NewGuid().ToString("N")[..8];
    var s = new string(input.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray());
    while (s.Contains("--")) s = s.Replace("--", "-");
    return s.Trim('-');
}


string? ThumbUrlFor(string slug, IWebHostEnvironment env)
{
    var rel  = $"/uploads/thumbnails/{slug}.png";
    var root = env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot");
    var abs  = Path.Combine(root, rel.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));

    return File.Exists(abs) ? rel : null;
}

// REST: create presentation
app.MapPost("/api/presentations", async (AppDbContext db, IWebHostEnvironment env, CreatePresentationDto dto) =>
{
    var title = (dto?.Title ?? "Untitled").Trim();
    var slugBase = Slugify(title);
    var slug = slugBase;
    var i = 2;
    while (await db.Presentations.AnyAsync(p => p.Slug == slug))
        slug = $"{slugBase}-{i++}";


    var p = new Presentation { Title = title, Slug = slug, CreatedAt = DateTime.UtcNow };
    db.Presentations.Add(p);
    // first slide
    db.Slides.Add(new Slide { PresentationId = p.Id, Position = 0, CreatedAt = DateTime.UtcNow });
    await db.SaveChangesAsync();


    return Results.Json(new {
        p.Id, p.Title, p.Slug, p.CreatedAt,
        ThumbnailUrl = (string?)null
    });
});

// REST: list presentations (with computed thumbnail urls)
app.MapGet("/api/presentations", async (AppDbContext db, IWebHostEnvironment env) =>
{
    var list = await db.Presentations
        .OrderByDescending(p => p.CreatedAt)
        .Select(p => new { p.Id, p.Title, p.Slug, p.CreatedAt })
        .ToListAsync();


    var withThumb = list.Select(p => new
    {
        p.Id,
        p.Title,
        p.Slug,
        p.CreatedAt,
        ThumbnailUrl = ThumbUrlFor(p.Slug, env)
    });
    return Results.Json(withThumb);
});

// REST: snapshot (presentation + slides + elements + members)
app.MapGet("/api/presentations/{slug}/snapshot", async (AppDbContext db, string slug) =>
{
    var preso = await db.Presentations.FirstOrDefaultAsync(p => p.Slug == slug);
    if (preso == null) return Results.NotFound();


    var slides = await db.Slides.Where(s => s.PresentationId == preso.Id).OrderBy(s => s.Position).ToListAsync();
    var slideIds = slides.Select(s => s.Id).ToList();
    var elements = await db.Elements.Where(e => slideIds.Contains(e.SlideId)).ToListAsync();
    var members = await db.Memberships.Where(m => m.PresentationId == preso.Id).ToListAsync();


    return Results.Json(new
    {
        Presentation = new { preso.Id, preso.Title, preso.Slug, preso.CreatedAt },
        Slides = slides,
        Elements = elements,
        Members = members
    });
});

// REST: upload image (multipart/form-data; field name "file")
app.MapPost("/api/uploads/image", async (HttpRequest req, IWebHostEnvironment env) =>
{
    if (!req.HasFormContentType) return Results.BadRequest("multipart/form-data required");
    var form = await req.ReadFormAsync();
    var file = form.Files["file"];
    if (file == null || file.Length == 0) return Results.BadRequest("file required");


    var root = env.WebRootPath ?? Path.Combine(app.Environment.ContentRootPath, "wwwroot");
    var dir = Path.Combine(root, "uploads", "images");
    Directory.CreateDirectory(dir);
    var name = Guid.NewGuid().ToString("N") + Path.GetExtension(file.FileName);
    var path = Path.Combine(dir, name);
    using (var fs = System.IO.File.Open(path, FileMode.Create))
        await file.CopyToAsync(fs);
    var url = "/uploads/images/" + name;
    return Results.Json(new { Url = url });
});

// REST: upload thumbnail as data URL; body: { dataUrl: "data:image/png;base64,..." }
app.MapPost("/api/presentations/{slug}/thumbnail", async (AppDbContext db, IWebHostEnvironment env, string slug, ThumbnailDto dto) =>
{
    var preso = await db.Presentations.FirstOrDefaultAsync(p => p.Slug == slug);
    if (preso == null) return Results.NotFound();
    if (dto == null || string.IsNullOrWhiteSpace(dto.DataUrl)) return Results.BadRequest("dataUrl required");


    var m = Regex.Match(dto.DataUrl, @"^data:image/(png|jpeg);base64,(.+)$", RegexOptions.IgnoreCase);
    if (!m.Success) return Results.BadRequest("invalid dataUrl");
    var base64 = m.Groups[2].Value;
    var bytes = Convert.FromBase64String(base64);


    var root = env.WebRootPath ?? Path.Combine(app.Environment.ContentRootPath, "wwwroot");
    var dir = Path.Combine(root, "uploads", "thumbnails");
    Directory.CreateDirectory(dir);
    var path = Path.Combine(dir, slug + ".png");
    await System.IO.File.WriteAllBytesAsync(path, bytes);
    var url = "/uploads/thumbnails/" + slug + ".png";
    return Results.Json(new { Url = url });
});

app.Run();


namespace Backend.Models
{
    public record CreatePresentationDto(string Title);
    public record ThumbnailDto(string DataUrl);
}