const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, nativeImage, screen, Notification, shell } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// Set FFmpeg and FFprobe paths for video clip extraction
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// Config
const API_URL = 'https://nexra-api.nexra-api.workers.dev';
const NEXRA_WEB_URL = 'https://nexra-jet.vercel.app';
const GAME_PROCESS_NAME = 'League of Legends.exe';
const CHECK_INTERVAL = 3000;
const LINK_SERVER_PORT = 45678; // Local server for account linking from dashboard
const MIN_GAME_DURATION = 900; // 15 minutes in seconds - skip remakes

let userConfig = {
  puuid: null,
  gameName: null,
  tagLine: null,
  region: 'EUW1',
  profileIconId: null,
  autoRecord: true,
  quality: 'medium',
  configVersion: 2
};

// Quality presets
const QUALITY_PRESETS = {
  low: { width: 854, height: 480, frameRate: 15, bitrate: 300000 },
  medium: { width: 854, height: 480, frameRate: 20, bitrate: 400000 },
  high: { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 }
};

let recorderWindow = null;
let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let isRecording = false;
let gameDetectionInterval = null;
let currentMatchId = null;
let gameStartTime = null;
let gameWasRunning = false;
let overlayShown = false;
let linkServer = null;
let recordingStartTime = null;

// Load config
function loadUserConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Load account data
      userConfig.puuid = savedConfig.puuid || null;
      userConfig.gameName = savedConfig.gameName || null;
      userConfig.tagLine = savedConfig.tagLine || null;
      userConfig.region = savedConfig.region || 'EUW1';
      userConfig.profileIconId = savedConfig.profileIconId || null;

      // Reset settings to correct defaults if config version is old
      if (savedConfig.configVersion !== 2) {
        userConfig.autoRecord = true;
        userConfig.quality = 'medium';
        userConfig.configVersion = 2;
        saveUserConfig();
        console.log('Config reset to new defaults');
      } else {
        userConfig.autoRecord = savedConfig.autoRecord;
        userConfig.quality = savedConfig.quality;
        userConfig.configVersion = savedConfig.configVersion;
      }

      console.log('Config loaded:', userConfig.gameName ? `${userConfig.gameName}#${userConfig.tagLine}` : 'No account');
    }
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
}

// Save config
function saveUserConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

// Fetch user config from Nexra
async function fetchUserConfigFromNexra() {
  try {
    const response = await fetch(`${NEXRA_WEB_URL}/api/user/riot-account`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.puuid) {
        userConfig.puuid = data.puuid;
        userConfig.gameName = data.gameName;
        userConfig.tagLine = data.tagLine;
        userConfig.region = data.region || 'EUW1';
        saveUserConfig();
        updateTrayMenu();
        return true;
      }
    }
  } catch (e) {
    console.log('Could not auto-configure');
  }
  return false;
}

// Fetch profile icon from Riot API if missing
async function fetchProfileIconId() {
  if (!userConfig.gameName || !userConfig.tagLine || userConfig.profileIconId) {
    return; // No account or already have profileIconId
  }

  try {
    const region = (userConfig.region || 'EUW1').toLowerCase();
    const url = `${NEXRA_WEB_URL}/api/riot/summoner?gameName=${encodeURIComponent(userConfig.gameName)}&tagLine=${encodeURIComponent(userConfig.tagLine)}&region=${region}`;

    const response = await fetch(url, { timeout: 10000 });

    if (response.ok) {
      const data = await response.json();
      if (data.profileIconId) {
        userConfig.profileIconId = data.profileIconId;
        saveUserConfig();
        sendStateToSettings();
        console.log('Profile icon fetched:', data.profileIconId);
      }
    }
  } catch (e) {
    console.log('Could not fetch profile icon:', e.message);
  }
}

// Create hidden recorder window
function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  recorderWindow.loadFile(path.join(__dirname, 'windows', 'recorder.html'));
  recorderWindow.webContents.on('did-finish-load', () => {
    console.log('Recorder ready');
  });
}

// Create overlay window - THIS IS THE KEY PART
function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const overlayWidth = 340;
  const overlayHeight = 180;

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: width - overlayWidth - 30,
    y: 30,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    hasShadow: false,
    // Critical for overlay over games
    type: 'toolbar',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'windows', 'overlay.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('Overlay window ready');
  });

  // Windows-specific: best settings for overlay over games
  if (process.platform === 'win32') {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  }
}

// Create settings window
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 340,
    x: Math.floor((width - 480) / 2),
    y: Math.floor((height - 340) / 2),
    frame: false,
    resizable: false,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'windows', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    sendStateToSettings();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// Send current state to settings window
function sendStateToSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;

  const recordings = getRecordingsList();

  settingsWindow.webContents.send('app-state', {
    isRecording,
    gameDetected: gameWasRunning,
    account: {
      gameName: userConfig.gameName,
      tagLine: userConfig.tagLine,
      region: userConfig.region,
      puuid: userConfig.puuid,
      profileIconId: userConfig.profileIconId,
    },
    autoRecord: userConfig.autoRecord,
    quality: userConfig.quality || 'medium',
    recordings,
  });
}

// Maximum recordings to keep locally
const MAX_LOCAL_RECORDINGS = 3;

// Get list of recordings for UI
function getRecordingsList() {
  const videosDir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(videosDir)) return [];

  try {
    const files = fs.readdirSync(videosDir)
      .filter(f => f.endsWith('.webm'))
      .map(f => {
        const filePath = path.join(videosDir, f);
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        const date = new Date(stats.mtime);
        const dateStr = date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        return {
          name: f.replace('.webm', '').substring(0, 20) + '...',
          path: filePath,
          date: dateStr,
          size: `${sizeMB} MB`,
          mtime: stats.mtime.getTime()
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files;
  } catch (err) {
    console.error('Error reading recordings:', err);
    return [];
  }
}

// Keep only the 3 most recent recordings
function cleanupOldRecordings() {
  const videosDir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(videosDir)) return;

  try {
    const files = fs.readdirSync(videosDir)
      .filter(f => f.endsWith('.webm'))
      .map(f => ({
        name: f,
        path: path.join(videosDir, f),
        mtime: fs.statSync(path.join(videosDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime);

    // Delete all but the 3 most recent
    if (files.length > MAX_LOCAL_RECORDINGS) {
      const toDelete = files.slice(MAX_LOCAL_RECORDINGS);
      toDelete.forEach(file => {
        try {
          fs.unlinkSync(file.path);
          console.log('Deleted old recording:', file.name);
        } catch (e) {
          console.error('Failed to delete:', file.name, e);
        }
      });
    }
  } catch (err) {
    console.error('Error cleaning up recordings:', err);
  }
}

// Clear all local recordings
function clearAllRecordings() {
  const videosDir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(videosDir)) return 0;

  try {
    const files = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm'));
    files.forEach(f => {
      try {
        fs.unlinkSync(path.join(videosDir, f));
      } catch (e) {
        console.error('Failed to delete:', f);
      }
    });
    console.log(`Cleared ${files.length} recordings`);
    return files.length;
  } catch (err) {
    console.error('Error clearing recordings:', err);
    return 0;
  }
}

// Show overlay over the game
function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }

  console.log('=== SHOWING OVERLAY ===');

  // Use full screen bounds (not workArea) to position over fullscreen games
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.bounds; // Use bounds, not workAreaSize
  const xPos = width - 370;
  const yPos = 30;

  console.log(`Positioning overlay at: ${xPos}, ${yPos}`);
  overlayWindow.setPosition(xPos, yPos);

  // Set always on top with maximum priority
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);

  // Show without stealing focus from the game
  overlayWindow.showInactive();

  // Ensure clickable
  overlayWindow.setIgnoreMouseEvents(false);

  overlayShown = true;
  console.log('Overlay shown, visible:', overlayWindow.isVisible());

  // Keep refreshing always-on-top to fight fullscreen games
  let refreshCount = 0;
  const keepOnTop = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      refreshCount++;
      // Log every 10 refreshes (5 seconds)
      if (refreshCount % 10 === 0) {
        console.log(`Overlay still visible, refresh #${refreshCount}`);
      }
    } else {
      console.log('Stopping overlay refresh');
      clearInterval(keepOnTop);
    }
  }, 500);

  // Auto-hide after 15 seconds if no action
  setTimeout(() => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible() && !isRecording) {
      console.log('Auto-hiding overlay (timeout)');
      hideOverlay();
    }
    clearInterval(keepOnTop);
  }, 15000);
}

// Hide overlay
function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
    overlayShown = false;
  }
}

// Create system tray
function createTray() {
  // Use the custom icon from assets folder
  const iconPath = path.join(__dirname, '..', 'assets', 'nexra-vision-ico.ico');
  let icon;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      throw new Error('Icon is empty');
    }
  } catch (e) {
    // Fallback to data URL if file not found
    console.log('Using fallback tray icon');
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFcSURBVFiF7ZYxTsNAEEX/bGwSiooiDRU9NfcgHIOGho6Wq1BwBBoKLpCOC1DQpKGgoKVAsiVbY4qVnNgbJ45TIP3GxfKsf/6bmf0L/HnIXhN5Hs2TN4cnABwAdVUdrNj6EBb6BvpfCfgzVrsrAE8AJgAiACMAj1U1TBwAXNS1vCkl0DYrFvBR1+IZwL2qhusIuAMQ1fHbBKDxJQJO2pYfAchUtGtIYNMEULMJOGgC0LQBqNkEnDQBaKYCNJuAkyaAdWmVJvn/BbwJoCx5KdHwCqDl7a5kA5bMy8nqGJi2fU9VQh1KJoC3Ni2AUwCLtQSopKkS0EYCfACbSwE0awK+6hgY2AA8LYXCOgJQS4BqCODjVv8XANW1vKLJBFxYCuVV3FZKUHr/SJpMwJlNAJoNKm0mAE0ToMkEXDYBUh7Hbf9hxQSg+ZcQ/gL+7xAfLQCOAGb/goDvAN5+ZML/AN5TtGqMohYzAAAAAElFTkSuQmCC'
    );
  }

  tray = new Tray(icon);
  updateTrayMenu();
  tray.setToolTip('Nexra Vision');
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', () => createSettingsWindow());
}

function updateTrayMenu() {
  const accountLabel = userConfig.gameName
    ? `[OK] ${userConfig.gameName}#${userConfig.tagLine}`
    : '[--] No account linked';

  const status = isRecording
    ? '[REC] Recording...'
    : gameWasRunning
      ? '[ON] Game detected'
      : '[--] Waiting...';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Nexra Vision', enabled: false },
    { type: 'separator' },
    { label: 'Open Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: accountLabel, enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: userConfig.puuid ? 'Re-sync Account' : 'Link Account',
      click: async () => {
        const success = await fetchUserConfigFromNexra();
        if (!success) {
          shell.openExternal(`${NEXRA_WEB_URL}/dashboard`);
          showNotification('Nexra Vision', 'Log in to Nexra to link account.');
        } else {
          showNotification('Account Linked', `${userConfig.gameName}#${userConfig.tagLine}`);
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(contextMenu);
}

function showNotification(title, body) {
  new Notification({ title, body }).show();
}

// Check if game is running
function checkGameRunning() {
  return new Promise((resolve) => {
    const cmd = `tasklist /FI "IMAGENAME eq ${GAME_PROCESS_NAME}" /NH`;
    exec(cmd, { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.toLowerCase().includes('league of legends'));
    });
  });
}

// Get complete match data from Riot API
async function getRealMatchData() {
  if (!userConfig.puuid) return null;

  try {
    console.log('Fetching match data from Riot API...');
    const response = await fetch(
      `${NEXRA_WEB_URL}/api/riot/matches?puuid=${userConfig.puuid}&region=${userConfig.region}&count=1`,
      { timeout: 15000 }
    );

    if (!response.ok) {
      console.error('Match fetch failed:', response.status);
      return null;
    }

    const matches = await response.json();
    if (matches && matches.length > 0) {
      const match = matches[0];
      const gameStartMs = gameStartTime ? gameStartTime.getTime() : 0;

      // Check if this match is from our recorded game (within 5 min tolerance)
      if (match.timestamp > gameStartMs - 300000) {
        console.log('Match found:', match.matchId, match.champion);

        // Return ALL available data for analysis
        return {
          // Basic info
          matchId: match.matchId,
          champion: match.champion,
          kills: match.kills,
          deaths: match.deaths,
          assists: match.assists,
          win: match.win,
          duration: match.gameDuration,
          gameMode: match.gameMode,
          queueId: match.queueId,
          timestamp: match.timestamp,

          // Role/Position
          role: match.role || match.teamPosition || match.individualPosition,
          lane: match.lane,
          teamPosition: match.teamPosition,

          // CS and Gold
          totalMinionsKilled: match.totalMinionsKilled,
          neutralMinionsKilled: match.neutralMinionsKilled,
          goldEarned: match.goldEarned,
          goldSpent: match.goldSpent,

          // Vision
          visionScore: match.visionScore,
          wardsPlaced: match.wardsPlaced,
          wardsKilled: match.wardsKilled,
          detectorWardsPlaced: match.detectorWardsPlaced,

          // Damage
          totalDamageDealtToChampions: match.totalDamageDealtToChampions,
          totalDamageTaken: match.totalDamageTaken,
          physicalDamageDealtToChampions: match.physicalDamageDealtToChampions,
          magicDamageDealtToChampions: match.magicDamageDealtToChampions,
          trueDamageDealtToChampions: match.trueDamageDealtToChampions,
          damageSelfMitigated: match.damageSelfMitigated,
          damageDealtToObjectives: match.damageDealtToObjectives,
          damageDealtToTurrets: match.damageDealtToTurrets,

          // Objectives
          turretKills: match.turretKills,
          inhibitorKills: match.inhibitorKills,

          // Combat stats
          doubleKills: match.doubleKills,
          tripleKills: match.tripleKills,
          quadraKills: match.quadraKills,
          pentaKills: match.pentaKills,
          largestKillingSpree: match.largestKillingSpree,
          largestMultiKill: match.largestMultiKill,
          firstBloodKill: match.firstBloodKill,
          firstBloodAssist: match.firstBloodAssist,
          firstTowerKill: match.firstTowerKill,
          firstTowerAssist: match.firstTowerAssist,

          // CC stats
          timeCCingOthers: match.timeCCingOthers,
          totalTimeCCDealt: match.totalTimeCCDealt,

          // Healing/Shielding
          totalHeal: match.totalHeal,
          totalDamageShieldedOnTeammates: match.totalDamageShieldedOnTeammates,

          // Items and Level
          items: match.items,
          champLevel: match.champLevel,
          summoner1Id: match.summoner1Id,
          summoner2Id: match.summoner2Id,
          perks: match.perks,

          // Player ranking in game (1 = MVP)
          rank: match.rank,

          // Teammates and enemies (for context)
          teammates: match.teammates,
          enemies: match.enemies,
        };
      } else {
        console.log('Match found but timestamp too old, not from this game');
      }
    }
  } catch (e) {
    console.error('Error fetching match:', e.message);
  }
  return null;
}

// Game detection loop
function startGameDetection() {
  console.log('Game detection started');

  gameDetectionInterval = setInterval(async () => {
    const isRunning = await checkGameRunning();

    // Game started
    if (isRunning && !gameWasRunning) {
      console.log('🎮 GAME STARTED!');
      gameStartTime = new Date();
      gameWasRunning = true;
      overlayShown = false;
      updateTrayMenu();

      // Game detected - no notification needed, overlay shows instead

      // Start recording after delay (let game load)
      setTimeout(() => {
        if (gameWasRunning && !isRecording) {
          if (userConfig.autoRecord) {
            // Auto-record: start directly without overlay
            console.log('Auto-recording enabled, starting recording...');
            startRecording();
          } else if (!overlayShown) {
            // Manual mode: show overlay to ask user
            console.log('Showing overlay to ask user...');
            showOverlay();
          }
        }
      }, 5000);
    }

    // Game ended
    if (!isRunning && gameWasRunning) {
      console.log('🏁 GAME ENDED!');
      gameWasRunning = false;
      overlayShown = false;
      updateTrayMenu();
      hideOverlay();

      if (isRecording) {
        stopRecording();
      }
    }
  }, CHECK_INTERVAL);
}

// Start recording
async function startRecording() {
  if (isRecording) return;

  try {
    isRecording = true;
    currentMatchId = `NEXRA_${Date.now()}`;
    recordingStartTime = Date.now();

    // Get both window and screen sources
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 }
    });

    // Try to find League of Legends game window (not the client/launcher)
    // Game window is usually just "League of Legends"
    // Client/Launcher is "League of Legends (TM) Client" or contains "Riot"
    const lolWindow = sources.find(source => {
      const name = source.name.toLowerCase();
      // Must contain "league of legends" but NOT "client" or "riot"
      return name.includes('league of legends') &&
             !name.includes('client') &&
             !name.includes('riot');
    });

    // Use LoL window if found, otherwise fall back to first screen
    const selectedSource = lolWindow || sources.find(s => s.id.startsWith('screen:')) || sources[0];

    console.log('Available sources:', sources.map(s => s.name));
    console.log('Selected source:', selectedSource?.name, selectedSource?.id);

    if (recorderWindow && !recorderWindow.isDestroyed()) {
      const qualitySettings = QUALITY_PRESETS[userConfig.quality] || QUALITY_PRESETS.medium;
      recorderWindow.webContents.send('start-recording', {
        sourceId: selectedSource.id,
        matchId: currentMatchId,
        quality: qualitySettings
      });
    }

    updateTrayMenu();
    sendStateToSettings();
    const sourceType = lolWindow ? 'LoL Window' : 'Screen';
    showNotification('Recording Started', `Capturing: ${sourceType}`);
    console.log('Recording started:', currentMatchId, '- Source:', selectedSource?.name);

  } catch (error) {
    console.error('Recording failed:', error);
    isRecording = false;
    showNotification('Error', error.message);
  }
}

// Stop recording
function stopRecording() {
  if (!isRecording) return;

  console.log('Stopping recording...');

  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('stop-recording');
  }

  isRecording = false;
  updateTrayMenu();
  sendStateToSettings();
  showNotification('Recording Saved', 'Analyzing...');
}


// IPC: Accept recording from overlay
ipcMain.on('accept-recording', () => {
  console.log('Recording accepted from overlay');
  hideOverlay();
  startRecording();
});

// IPC: Decline recording from overlay
ipcMain.on('decline-recording', () => {
  console.log('Recording declined from overlay');
  hideOverlay();
});

// IPC: Settings window requests
ipcMain.on('get-app-state', () => {
  sendStateToSettings();
});

ipcMain.on('link-account', () => {
  shell.openExternal(`${NEXRA_WEB_URL}/dashboard?link=vision`);
});

ipcMain.on('set-auto-record', (event, value) => {
  userConfig.autoRecord = value;
  saveUserConfig();
  sendStateToSettings();
});

ipcMain.on('set-quality', (event, quality) => {
  if (QUALITY_PRESETS[quality]) {
    userConfig.quality = quality;
    saveUserConfig();
    sendStateToSettings();
    console.log('Quality set to:', quality);
  }
});

ipcMain.on('open-dashboard', () => {
  shell.openExternal(`${NEXRA_WEB_URL}/dashboard`);
});

ipcMain.on('clear-recordings', () => {
  const count = clearAllRecordings();
  sendStateToSettings();
  console.log(`Cleared ${count} recordings`);
});

// IPC: Recording data received
ipcMain.on('recording-data', async (event, { buffer, matchId }) => {
  console.log('Recording data received:', matchId, 'Size:', buffer.length);

  // Calculate recording duration as fallback
  const recordingDuration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
  console.log('Recording duration:', recordingDuration, 'seconds');

  const videosDir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const videoPath = path.join(videosDir, `${matchId}.webm`);
  const videoBuffer = Buffer.from(buffer);
  fs.writeFileSync(videoPath, videoBuffer);
  console.log('Video saved:', videoPath);

  // Wait for Riot API
  let realMatchData = null;
  if (userConfig.puuid) {
    // Wait for Riot API silently
    await new Promise(resolve => setTimeout(resolve, 30000));
    realMatchData = await getRealMatchData();
    if (realMatchData) {
      console.log('Match data:', realMatchData.champion, 'Duration:', realMatchData.duration);
    }
  }

  // Check if game is a remake (< 15 minutes)
  // Use Riot API duration if available, otherwise use recording duration
  const gameDuration = realMatchData?.duration || recordingDuration;

  if (gameDuration < MIN_GAME_DURATION) {
    console.log(`Game too short (${gameDuration}s < ${MIN_GAME_DURATION}s) - Skipping upload (probable remake)`);

    // Delete local video file for remakes
    try {
      fs.unlinkSync(videoPath);
      console.log('Deleted remake video:', videoPath);
    } catch (err) {
      console.error('Failed to delete remake video:', err);
    }

    recordingStartTime = null;
    return;
  }

  try {
    await uploadToApi(matchId, videoBuffer, realMatchData);
  } catch (error) {
    console.error('Upload failed:', error);
    showNotification('Upload Failed', 'Saved locally');
  }

  // Cleanup old recordings (keep only 3 most recent)
  cleanupOldRecordings();
  sendStateToSettings();

  recordingStartTime = null;
});

// Re-analyze an existing video from the recordings directory
async function reanalyzeLastRecording() {
  const videosDir = path.join(app.getPath('userData'), 'recordings');

  if (!fs.existsSync(videosDir)) {
    console.log('No recordings directory found');
    return;
  }

  // Get all .webm files sorted by modification time (newest first)
  const files = fs.readdirSync(videosDir)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({
      name: f,
      path: path.join(videosDir, f),
      mtime: fs.statSync(path.join(videosDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.log('No recordings found');
    return;
  }

  const latestVideo = files[0];
  console.log('Re-analyzing:', latestVideo.name);

  try {
    const videoBuffer = fs.readFileSync(latestVideo.path);
    const localMatchId = latestVideo.name.replace('.webm', '');

    // Get match data from Riot API
    let realMatchData = null;
    if (userConfig.puuid) {
      realMatchData = await getRealMatchData();
      if (realMatchData) {
        console.log('Match data for re-analysis:', realMatchData.champion);
      }
    }

    const matchId = realMatchData?.matchId || localMatchId;
    const puuid = userConfig.puuid || 'local-user';
    const region = userConfig.region || 'EUW1';

    // Check if recording already exists
    const checkResponse = await fetch(`${API_URL}/recordings/check/${matchId}`);
    const checkData = await checkResponse.json();

    if (checkData.success && checkData.data?.exists) {
      console.log('Recording already exists, checking for existing analysis...');

      // First, try to find the existing analysis ID
      const existingAnalysisResponse = await fetch(`${API_URL}/analysis/match/${matchId}`);
      const existingAnalysisData = await existingAnalysisResponse.json();

      if (existingAnalysisData.success && existingAnalysisData.data?.id) {
        // Use the reanalyze endpoint
        const analysisId = existingAnalysisData.data.id;
        console.log(`Found existing analysis ${analysisId}, triggering re-analysis...`);

        const reanalyzeResponse = await fetch(`${API_URL}/analysis/${analysisId}/reanalyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        const reanalyzeData = await reanalyzeResponse.json();
        if (!reanalyzeData.success) {
          throw new Error(reanalyzeData.error || 'Failed to start re-analysis');
        }
      } else {
        // No existing analysis, create a new one
        console.log('No existing analysis, creating new...');

        const analysisResponse = await fetch(`${API_URL}/analysis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matchId,
            puuid,
            region,
            matchData: realMatchData || {},
          }),
        });

        const analysisData = await analysisResponse.json();
        if (!analysisData.success) {
          throw new Error(analysisData.error || 'Failed to start analysis');
        }
      }
    } else {
      // Recording doesn't exist, do full upload
      await uploadToApi(localMatchId, videoBuffer, realMatchData);
    }
  } catch (error) {
    console.error('Re-analysis failed:', error);
  }
}

// List available recordings for re-analysis
function listRecordings() {
  const videosDir = path.join(app.getPath('userData'), 'recordings');

  if (!fs.existsSync(videosDir)) {
    return [];
  }

  return fs.readdirSync(videosDir)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({
      name: f,
      path: path.join(videosDir, f),
      matchId: f.replace('.webm', ''),
      mtime: fs.statSync(path.join(videosDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// Fetch timeline data to get important event timestamps
async function fetchTimeline(matchId, puuid, region) {
  try {
    const response = await fetch(
      `${NEXRA_WEB_URL}/api/riot/timeline?matchId=${matchId}&puuid=${puuid}&region=${region}`
    );

    if (!response.ok) {
      console.log('Timeline API unavailable, will use stats-only analysis');
      return null;
    }

    const data = await response.json();
    console.log(`Timeline fetched: ${data.clips?.length || 0} important moments found`);
    return data;
  } catch (error) {
    console.error('Failed to fetch timeline:', error.message);
    return null;
  }
}

// Extract a single video clip using FFmpeg
async function extractSingleClip(videoPath, clip, index, outputDir, totalClips) {
  const clipPath = path.join(outputDir, `clip_${index}_${clip.type}.webm`);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .setStartTime(clip.startTime)
      .setDuration(clip.duration || 20) // Reduced to 20 seconds
      .output(clipPath)
      .outputOptions([
        '-c:v libvpx', // VP8 is faster than VP9
        '-crf 35',     // Higher CRF = faster encoding
        '-b:v 500K',   // Lower bitrate for faster processing
        '-deadline realtime', // Fastest encoding mode
        '-cpu-used 5', // Faster CPU usage
        '-an'          // No audio (faster)
      ])
      .on('end', () => {
        console.log(`Clip ${index + 1}/${totalClips} extracted: ${clip.description}`);
        resolve({
          ...clip,
          localPath: clipPath,
          index
        });
      })
      .on('error', (err) => {
        console.error(`Failed to extract clip ${index}:`, err.message);
        resolve(null); // Don't reject, just return null
      })
      .run();
  });
}

// Extract video clips using FFmpeg - PARALLEL VERSION
async function extractClips(videoPath, clips, outputDir) {
  if (!clips || clips.length === 0) {
    console.log('No clips to extract');
    return [];
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Prioritize and limit clips: deaths first, then kills, then objectives
  const priorityOrder = { death: 0, kill: 1, objective: 2, other: 3 };
  const sortedClips = [...clips].sort((a, b) => {
    const priorityA = priorityOrder[a.type] ?? 3;
    const priorityB = priorityOrder[b.type] ?? 3;
    if (priorityA !== priorityB) return priorityA - priorityB;
    // Same priority: sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
  });

  // Process ALL clips (deaths first, then kills, then objectives)
  const limitedClips = sortedClips;
  console.log(`Processing ALL ${limitedClips.length} clips (deaths prioritized)`);

  // Process clips in parallel batches of 4
  const BATCH_SIZE = 4;
  const extractedClips = [];

  for (let i = 0; i < limitedClips.length; i += BATCH_SIZE) {
    const batch = limitedClips.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(limitedClips.length / BATCH_SIZE);

    console.log(`Extracting batch ${batchNum}/${totalBatches} (${batch.length} clips in parallel)...`);

    const batchResults = await Promise.all(
      batch.map((clip, batchIndex) =>
        extractSingleClip(videoPath, clip, i + batchIndex, outputDir, limitedClips.length)
      )
    );

    // Filter out failed extractions (nulls)
    extractedClips.push(...batchResults.filter(Boolean));
  }

  console.log(`Successfully extracted ${extractedClips.length}/${limitedClips.length} clips`);
  return extractedClips;
}

// Extract frames from a clip for Claude Vision analysis
async function extractFramesFromClip(clipPath, outputDir, numFrames = 5) {
  const frames = [];

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    // Get clip duration first
    ffmpeg.ffprobe(clipPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = metadata.format.duration;
      const interval = duration / (numFrames + 1);

      let extractedCount = 0;

      for (let i = 1; i <= numFrames; i++) {
        const timestamp = interval * i;
        const framePath = path.join(outputDir, `frame_${i}.jpg`);

        ffmpeg(clipPath)
          .screenshots({
            timestamps: [timestamp],
            filename: `frame_${i}.jpg`,
            folder: outputDir,
            size: '1280x720'
          })
          .on('end', () => {
            frames.push({
              path: framePath,
              timestamp: timestamp
            });
            extractedCount++;
            if (extractedCount === numFrames) {
              resolve(frames);
            }
          })
          .on('error', (err) => {
            console.error(`Failed to extract frame ${i}:`, err.message);
            extractedCount++;
            if (extractedCount === numFrames) {
              resolve(frames);
            }
          });
      }
    });
  });
}

// Upload to API with video clips for AI analysis
async function uploadToApi(matchId, videoBuffer, realMatchData) {
  const puuid = userConfig.puuid || 'local-user';
  const region = userConfig.region || 'EUW1';
  const finalMatchId = realMatchData?.matchId || matchId;

  console.log('Processing video for AI analysis...', finalMatchId);

  // Prepare match data payload
  const matchDataPayload = realMatchData ? {
    champion: realMatchData.champion,
    kills: realMatchData.kills,
    deaths: realMatchData.deaths,
    assists: realMatchData.assists,
    win: realMatchData.win,
    duration: realMatchData.duration,
    gameMode: realMatchData.gameMode,
    queueId: realMatchData.queueId,
    role: realMatchData.role,
    lane: realMatchData.lane,
    teamPosition: realMatchData.teamPosition,
    totalMinionsKilled: realMatchData.totalMinionsKilled,
    neutralMinionsKilled: realMatchData.neutralMinionsKilled,
    goldEarned: realMatchData.goldEarned,
    goldSpent: realMatchData.goldSpent,
    visionScore: realMatchData.visionScore,
    wardsPlaced: realMatchData.wardsPlaced,
    wardsKilled: realMatchData.wardsKilled,
    detectorWardsPlaced: realMatchData.detectorWardsPlaced,
    totalDamageDealtToChampions: realMatchData.totalDamageDealtToChampions,
    totalDamageTaken: realMatchData.totalDamageTaken,
    damageDealtToObjectives: realMatchData.damageDealtToObjectives,
    doubleKills: realMatchData.doubleKills,
    tripleKills: realMatchData.tripleKills,
    quadraKills: realMatchData.quadraKills,
    pentaKills: realMatchData.pentaKills,
    firstBloodKill: realMatchData.firstBloodKill,
    firstTowerKill: realMatchData.firstTowerKill,
    items: realMatchData.items,
    champLevel: realMatchData.champLevel,
    summoner1Id: realMatchData.summoner1Id,
    summoner2Id: realMatchData.summoner2Id,
    rank: realMatchData.rank,
    teammates: realMatchData.teammates,
    enemies: realMatchData.enemies,
  } : {};

  // Create temp directory for processing
  const tempDir = path.join(app.getPath('temp'), 'nexra-clips', finalMatchId);
  const videoPath = path.join(tempDir, 'full_recording.webm');
  const clipsDir = path.join(tempDir, 'clips');
  const framesDir = path.join(tempDir, 'frames');

  try {
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Save video buffer to temp file
    fs.writeFileSync(videoPath, videoBuffer);
    console.log('Video saved to temp file:', videoPath);

    // Fetch timeline to get important events
    let timelineData = null;
    let extractedClips = [];

    if (realMatchData?.matchId && !realMatchData.matchId.startsWith('NEXRA_')) {
      console.log('Fetching timeline for important moments...');
      timelineData = await fetchTimeline(finalMatchId, puuid, region);

      if (timelineData?.clips?.length > 0) {
        console.log(`Extracting ${timelineData.clips.length} clips...`);

        extractedClips = await extractClips(videoPath, timelineData.clips, clipsDir);
        console.log(`Successfully extracted ${extractedClips.length} clips`);
      }
    }

    // 1. Create recording entry
    const uploadUrlResponse = await fetch(`${API_URL}/recordings/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId: finalMatchId,
        puuid,
        region,
        fileSize: videoBuffer.length,
        clipCount: extractedClips.length,
      }),
    });

    const uploadUrlData = await uploadUrlResponse.json();
    if (!uploadUrlData.success) throw new Error(uploadUrlData.error);

    const { recordingId } = uploadUrlData.data;
    console.log('Recording created:', recordingId);

    // 2. Upload full video (for playback on dashboard)
    console.log('Uploading full video...');
    const uploadResponse = await fetch(`${API_URL}/recordings/${recordingId}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: videoBuffer,
    });

    const uploadData = await uploadResponse.json();
    if (!uploadData.success) throw new Error(uploadData.error);
    console.log('Full video uploaded successfully');

    // 3. Upload extracted clips for AI analysis (PARALLEL)
    console.log(`Uploading ${extractedClips.length} clips with frames (parallel)...`);

    // Process clips in parallel - extract frames and upload
    const uploadClipWithFrames = async (clip, index) => {
      try {
        // Extract frames for Claude Vision (reduced to 3 frames for speed)
        const clipFramesDir = path.join(framesDir, `clip_${index}`);
        const frames = await extractFramesFromClip(clip.localPath, clipFramesDir, 3);

        // Convert frames to base64 for API
        const frameData = frames.map(f => {
          if (fs.existsSync(f.path)) {
            return {
              timestamp: f.timestamp,
              data: fs.readFileSync(f.path).toString('base64')
            };
          }
          return null;
        }).filter(Boolean);

        // Upload clip
        const clipUploadResponse = await fetch(`${API_URL}/recordings/${recordingId}/clips`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            index,
            type: clip.type,
            description: clip.description,
            startTime: clip.startTime,
            endTime: clip.endTime,
            severity: clip.severity,
            frames: frameData,
          }),
        });

        const clipUploadData = await clipUploadResponse.json();
        if (clipUploadData.success) {
          console.log(`Clip ${index + 1}/${extractedClips.length} uploaded with ${frameData.length} frames`);
          return {
            ...clip,
            clipId: clipUploadData.data?.clipId,
            frameCount: frameData.length
          };
        }
      } catch (clipErr) {
        console.error(`Failed to upload clip ${index}:`, clipErr.message);
      }
      return null;
    };

    // Upload all clips in parallel (limited concurrency to avoid overwhelming API)
    const uploadResults = await Promise.all(
      extractedClips.map((clip, index) => uploadClipWithFrames(clip, index))
    );
    const uploadedClips = uploadResults.filter(Boolean);

    console.log(`Uploaded ${uploadedClips.length}/${extractedClips.length} clips`);

    // 4. Create analysis record (in pending status)
    console.log('Creating analysis record...');
    const analysisResponse = await fetch(`${API_URL}/analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId: finalMatchId,
        puuid,
        region,
        matchData: matchDataPayload,
        hasVideoClips: uploadedClips.length > 0,
        clipCount: uploadedClips.length,
        timelineEvents: timelineData?.events || [],
      }),
    });

    const analysisData = await analysisResponse.json();
    if (analysisData.success && analysisData.data?.id) {
      const analysisId = analysisData.data.id;
      console.log(`Analysis created with ID: ${analysisId}, starting processing...`);

      // 5. Start the analysis processing
      const startResponse = await fetch(`${API_URL}/analysis/${analysisId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const startData = await startResponse.json();
      if (startData.success) {
        console.log('AI Analysis started successfully');
      } else {
        console.error('Analysis start failed:', startData.error);
      }
    } else {
      console.error('Analysis creation failed:', analysisData.error);
    }

    // Cleanup temp files after a delay
    setTimeout(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('Cleaned up temp files');
      } catch (e) {
        console.log('Temp cleanup skipped');
      }
    }, 60000); // Clean up after 1 minute

  } catch (error) {
    console.error('Upload process failed:', error);
    throw error;
  }
}

// Start local HTTP server for account linking from dashboard
function startLinkServer() {
  if (linkServer) return;

  linkServer = http.createServer((req, res) => {
    // Enable CORS for dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /status - Check if Nexra Vision is running
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        running: true,
        linked: !!userConfig.puuid,
        account: userConfig.gameName ? `${userConfig.gameName}#${userConfig.tagLine}` : null
      }));
      return;
    }

    // POST /link - Receive account data from dashboard
    if (req.method === 'POST' && req.url === '/link') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          console.log('Received account link request:', data.gameName);

          if (data.puuid && data.gameName && data.tagLine) {
            userConfig.puuid = data.puuid;
            userConfig.gameName = data.gameName;
            userConfig.tagLine = data.tagLine;
            userConfig.region = data.region || 'EUW1';
            userConfig.profileIconId = data.profileIconId || null;
            saveUserConfig();
            updateTrayMenu();
            sendStateToSettings();

            // Fetch profile icon if not provided
            if (!userConfig.profileIconId) {
              fetchProfileIconId();
            }

            showNotification('Account Linked', `${userConfig.gameName}#${userConfig.tagLine}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Account linked successfully' }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
          }
        } catch (e) {
          console.error('Link request parse error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // 404 for other routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
  });

  linkServer.listen(LINK_SERVER_PORT, '127.0.0.1', () => {
    console.log(`Link server started on port ${LINK_SERVER_PORT}`);
  });

  linkServer.on('error', (err) => {
    console.error('Link server error:', err.message);
    linkServer = null;
  });
}

// Stop link server
function stopLinkServer() {
  if (linkServer) {
    linkServer.close();
    linkServer = null;
    console.log('Link server stopped');
  }
}

// App start
app.whenReady().then(async () => {
  console.log('========================================');
  console.log('NEXRA VISION');
  console.log('========================================');

  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  // Enable auto-start on Windows boot
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe'),
    args: ['--hidden']
  });

  loadUserConfig();

  if (!userConfig.puuid) {
    await fetchUserConfigFromNexra();
  }

  // Fetch profile icon if missing
  if (userConfig.gameName && !userConfig.profileIconId) {
    fetchProfileIconId();
  }

  // Cleanup old recordings on startup (keep only 3)
  cleanupOldRecordings();

  createRecorderWindow();
  createOverlayWindow();
  createTray();
  startGameDetection();
  startLinkServer();

  // Show settings window on startup
  createSettingsWindow();

  console.log('Account:', userConfig.gameName || 'Not linked');
  console.log('Hotkey: F9');
  console.log('========================================');
});

app.on('will-quit', () => {
  if (gameDetectionInterval) clearInterval(gameDetectionInterval);
  stopLinkServer();
});

app.on('window-all-closed', (e) => e.preventDefault());
