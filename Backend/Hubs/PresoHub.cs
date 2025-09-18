using Microsoft.AspNetCore.SignalR;
using Backend.Data;
using Backend.Models;
using Microsoft.EntityFrameworkCore;
using System.Collections.Concurrent;


namespace Backend.Hubs
{
    public class PresoHub : Hub
    {
        private readonly AppDbContext _db;
        public PresoHub(AppDbContext db) { _db = db; }


        private static readonly ConcurrentDictionary<string, (Guid UserId, string Nickname, string Slug)> _conn = new();
        private static readonly ConcurrentDictionary<Guid, Guid> _locks = new(); // ElementId -> UserId


        private async Task<(Presentation preso, AppUser user, Membership membership)> EnsureContext()
        {
            var http = Context.GetHttpContext();
            var slug = http?.Request.Query["slug"].ToString() ?? "";
            var nick = http?.Request.Query["nickname"].ToString() ?? "guest";
            if (string.IsNullOrWhiteSpace(slug)) throw new HubException("slug required");


            var preso = await _db.Presentations.FirstOrDefaultAsync(p => p.Slug == slug)
                ?? throw new HubException("presentation not found");


            var user = await _db.Users.FirstOrDefaultAsync(u => u.Nickname == nick);
            if (user == null)
            {
                user = new AppUser { Nickname = nick, CreatedAt = DateTime.UtcNow };
                _db.Users.Add(user);
                await _db.SaveChangesAsync();
            }


            var hasMembers = await _db.Memberships.AnyAsync(m => m.PresentationId == preso.Id);
            var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.PresentationId == preso.Id && m.UserId == user.Id);
            if (membership == null)
            {
                membership = new Membership
                {
                    PresentationId = preso.Id,
                    UserId = user.Id,
                    Nickname = user.Nickname,
                    Role = hasMembers ? "viewer" : "creator"
                };
                _db.Memberships.Add(membership);
                await _db.SaveChangesAsync();
            }
            return (preso, user, membership);
        }


        public override async Task OnConnectedAsync()
        {
            var (preso, user, membership) = await EnsureContext();
            var group = $"preso:{preso.Slug}";
            _conn[Context.ConnectionId] = (user.Id, user.Nickname, preso.Slug);
            await Groups.AddToGroupAsync(Context.ConnectionId, group);


            // send initial presence + locks
            var others = await _db.Memberships.Where(m => m.PresentationId == preso.Id).ToListAsync();
            await Clients.Caller.SendAsync("PresenceSnapshot", new { Members = others, Locks = _locks.ToDictionary(k => k.Key, v => v.Value) });
            await Clients.OthersInGroup(group).SendAsync("UserJoined", new { ConnectionId = Context.ConnectionId, UserId = user.Id, Nickname = user.Nickname, Role = membership.Role });


            await base.OnConnectedAsync();
        }


        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (_conn.TryRemove(Context.ConnectionId, out var info))
            {
                var group = $"preso:{info.Slug}";
                // release any locks held by this user
                foreach (var kv in _locks.Where(k => k.Value == info.UserId).ToList())
                {
                    _locks.TryRemove(kv.Key, out _);
                }
                await Clients.Group(group).SendAsync("UserLeft", new { ConnectionId = Context.ConnectionId, UserId = info.UserId, Nickname = info.Nickname });
                await Clients.Group(group).SendAsync("LocksUpdated", _locks);
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, group);
            }
            await base.OnDisconnectedAsync(exception);
        }


        private async Task<string> RequireRole(Guid presoId, Guid userId)
        {
            var m = await _db.Memberships.FirstOrDefaultAsync(x => x.PresentationId == presoId && x.UserId == userId);
            if (m == null) throw new HubException("not a member");
            return m.Role;
        }

        public Task Cursor(string slug, object payload)
            => Clients.OthersInGroup($"preso:{slug}").SendAsync("CursorPresence", payload);


                // --- Slides (creator only) ---
        public async Task<Guid> AddSlide(string slug)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var (userId, _) = (_conn[Context.ConnectionId].UserId, _conn[Context.ConnectionId].Nickname);
            var role = await RequireRole(preso.Id, userId);
            if (role != "creator") throw new HubException("Only creator can add slides");


            var maxPos = await _db.Slides.Where(s => s.PresentationId == preso.Id).Select(s => (int?)s.Position).MaxAsync() ?? -1;
            var slide = new Slide { PresentationId = preso.Id, Position = maxPos + 1, CreatedAt = DateTime.UtcNow };
            _db.Slides.Add(slide);
            await _db.SaveChangesAsync();
            await Clients.Group($"preso:{slug}").SendAsync("SlideAdded", slide);
            return slide.Id;
        }

        public async Task DeleteSlide(string slug, Guid slideId)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var userId = _conn[Context.ConnectionId].UserId;
            var role = await RequireRole(preso.Id, userId);
            if (role != "creator") throw new HubException("Only creator can delete slides");


            var s = await _db.Slides.FirstOrDefaultAsync(x => x.Id == slideId);
            if (s == null) return;
            _db.Slides.Remove(s);
            await _db.SaveChangesAsync();
            await Clients.Group($"preso:{slug}").SendAsync("SlideDeleted", slideId);
        }


                // --- Elements (editor or creator) ---
        public async Task<Element> CreateElement(string slug, Element payload)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var userId = _conn[Context.ConnectionId].UserId;
            var role = await RequireRole(preso.Id, userId);
            if (role != "creator" && role != "editor") throw new HubException("Insufficient role");


            payload.Id = Guid.NewGuid();
            payload.UpdatedAt = DateTime.UtcNow;
            _db.Elements.Add(payload);
            await _db.SaveChangesAsync();
            await Clients.OthersInGroup($"preso:{slug}").SendAsync("ElementCreated", payload);
            return payload;
        }

        public async Task UpdateElement(string slug, Element payload)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var userId = _conn[Context.ConnectionId].UserId;
            var role = await RequireRole(preso.Id, userId);
            if (role != "creator" && role != "editor") throw new HubException("Insufficient role");


            if (_locks.TryGetValue(payload.Id, out var locker) && locker != userId)
                throw new HubException("Element locked by another user");


            var exist = await _db.Elements.FirstOrDefaultAsync(e => e.Id == payload.Id);
            if (exist == null) throw new HubException("not found");
            exist.X = payload.X; exist.Y = payload.Y; exist.W = payload.W; exist.H = payload.H;
            exist.Z = payload.Z; exist.Kind = payload.Kind; exist.Props = payload.Props;
            exist.UpdatedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
            await Clients.OthersInGroup($"preso:{slug}").SendAsync("ElementUpdated", exist);
        }

        public async Task DeleteElement(string slug, Guid elementId)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var userId = _conn[Context.ConnectionId].UserId;
            var role = await RequireRole(preso.Id, userId);
            if (role != "creator" && role != "editor") throw new HubException("Insufficient role");


            if (_locks.TryGetValue(elementId, out var locker) && locker != userId)
                throw new HubException("Element locked by another user");


            var exist = await _db.Elements.FirstOrDefaultAsync(e => e.Id == elementId);
            if (exist == null) return;
            _db.Elements.Remove(exist);
            await _db.SaveChangesAsync();
            await Clients.OthersInGroup($"preso:{slug}").SendAsync("ElementDeleted", elementId);
        }

        public async Task<bool> LockElement(string slug, Guid elementId)
        {
            var userId = _conn[Context.ConnectionId].UserId;
            var ok = _locks.TryAdd(elementId, userId);
            await Clients.Group($"preso:{slug}").SendAsync("LocksUpdated", _locks);
            return ok;
        }


        public async Task UnlockElement(string slug, Guid elementId)
        {
            _locks.TryRemove(elementId, out _);
            await Clients.Group($"preso:{slug}").SendAsync("LocksUpdated", _locks);
        }

        public async Task SetRole(string slug, Guid targetUserId, string role)
        {
            var preso = await _db.Presentations.FirstAsync(p => p.Slug == slug);
            var actorId = _conn[Context.ConnectionId].UserId;
            var actorRole = await RequireRole(preso.Id, actorId);
            if (actorRole != "creator") throw new HubException("Only creator can change roles");
            if (role != "viewer" && role != "editor") throw new HubException("Invalid role");


            var m = await _db.Memberships.FirstOrDefaultAsync(x => x.PresentationId == preso.Id && x.UserId == targetUserId)
            ?? throw new HubException("member not found");
            m.Role = role;
            await _db.SaveChangesAsync();
            await Clients.Group($"preso:{slug}").SendAsync("RoleChanged", new { targetUserId, role });
        }
    }
}