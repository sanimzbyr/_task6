# Collaborative Presentation (ASP.NET + PostgreSQL + Vite+TS)

## Prereqs
- .NET 8 SDK
- Node.js 18+ 
- PostgreSQL (local)

## Quick start

### 1) Backend
```bash
cd Backend
dotnet restore
dotnet run --urls http://localhost:5199
```
The app will auto-create the database if it doesn't exist (using `EnsureCreated`). Default connection string is in `appsettings.json`:
```
Host=localhost;Database=preso;Username=postgres;Password=postgres
```
Change as needed.

### 2) Frontend
```bash
cd Frontend
npm install
npm run dev
```
Open http://localhost:5173

## Features included
- Create presentation (auto adds first slide)
- Open editor (enter nickname)
- Real-time element create/update via SignalR
- Drag/resize elements (interact.js)
- Markdown text blocks (double-click to edit)
- Pan/zoom canvas (panzoom)
- Basic thumbnails placeholder area
- Simple image upload endpoint (POST /api/uploads/image with form field `file`)

> This is a minimal but complete baseline; extend roles, soft-locks, shapes, and export PDF per your needs.
