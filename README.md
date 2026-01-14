# Nexra Vision

Desktop application for recording League of Legends games for AI-powered analysis.

## Features

- Automatic game detection (League of Legends)
- Overlay prompt when game starts
- Screen recording in background
- Auto-upload to Nexra API after game ends
- System tray integration

## Development

### Prerequisites

- Node.js 18+
- npm

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm start
```

### Build for distribution

```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

## How it works

1. App runs in the system tray
2. Detects when `League of Legends.exe` starts
3. Shows an overlay asking to record
4. If accepted, records the screen
5. When game ends, saves the recording
6. Uploads to Nexra API for AI analysis

## Configuration

Edit `src/main.js` to change:

- `API_URL` - Nexra API endpoint
- `GAME_PROCESS_NAME` - Process name to detect
- `CHECK_INTERVAL` - How often to check for game (ms)

## Tech Stack

- Electron
- MediaRecorder API for screen capture
- Native notifications
- System tray integration
