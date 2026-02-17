# 3D Model Cross-Search

A web application that searches for 3D printable models across multiple popular repositories simultaneously.

## Features

- **Unified Search** - Search Thingiverse, Printables, Thangs, MyMiniFactory, YouMagine, and Creality Cloud from one interface
- **Popular Models** - Browse trending models from each source
- **Real-time Results** - Results stream in as each source responds
- **Image Proxy** - Built-in proxy to handle CDN restrictions
- **Responsive Design** - Works on desktop and mobile

## Supported Sources

| Source | Search | Popular | Notes |
|--------|--------|---------|-------|
| Thingiverse | ✅ | ✅ | API key recommended |
| Printables | ✅ | ✅ | GraphQL API |
| Thangs | ⚠️ | ✅ | Cloudflare protected (fallback data) |
| MyMiniFactory | ⚠️ | ✅ | Cloudflare protected (fallback data) |
| YouMagine | ✅ | ✅ | Web scraping |
| Creality Cloud | ✅ | ✅ | REST API |

## Quick Start

### Using Docker (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/3d-model-search.git
   cd 3d-model-search
   ```

2. Create a `.env` file (optional, for Thingiverse API):
   ```bash
   cp .env.example .env
   # Edit .env and add your Thingiverse API key
   ```

3. Run with Docker Compose:
   ```bash
   docker compose up --build
   ```

4. Open http://localhost:3000

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file (optional):
   ```bash
   cp .env.example .env
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open http://localhost:3000

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `THINGIVERSE_API_KEY` | Thingiverse API key for better search results | No |

### Getting a Thingiverse API Key

1. Go to https://www.thingiverse.com/developers
2. Create a new app
3. Copy the App Token to your `.env` file

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q={query}` | Search all sources |
| `GET /api/popular` | Get popular models from all sources |
| `GET /api/image?url={url}` | Proxy for CDN images |
| `GET /api/health` | Health check |

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Scraping**: Cheerio
- **Container**: Docker

## License

MIT
