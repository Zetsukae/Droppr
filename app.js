const clockElement = document.querySelector('#clock');
const playbackStatus = document.querySelector('#playback-status');
const enablePlaybackButton = document.querySelector('#enable-playback');
const songFileInput = document.querySelector('#song-file');
const emptySong = document.querySelector('#empty-song');
const songEditor = document.querySelector('#song-editor');
const songName = document.querySelector('#song-name');
const songDuration = document.querySelector('#song-duration');
const player = document.querySelector('#player');
const markDropButton = document.querySelector('#mark-drop');
const dropPointLabel = document.querySelector('#drop-point-label');
const dropForm = document.querySelector('#drop-form');
const dropTimeInput = document.querySelector('#drop-time');
const scheduleButton = document.querySelector('#schedule-drop');
const dropList = document.querySelector('#drop-list');
const emptyDrops = document.querySelector('#empty-drops');
const scheduleWarning = document.querySelector('#schedule-warning');
const warningCopy = document.querySelector('#warning-copy');
const enableAndScheduleButton = document.querySelector('#enable-and-schedule');
const scheduleWithoutPlaybackButton = document.querySelector('#schedule-without-playback');
const cancelScheduleButton = document.querySelector('#cancel-schedule');
const clockFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const dropDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let database;
let songs = [];
let drops = [];
let audioContext = null;
let currentSong = null;
let dropPoint = 0;
let dropInitializedSongId = null;
let playbackEnabled = false;
let activeObjectUrl = null;
let loadedSongId = null;
let pendingDrop = null;
const decodedAudio = new Map();
const scheduledSources = new Map();
const armingDrops = new Set();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('droppr', 1);
    request.onupgradeneeded = () => {
      const store = request.result;
      if (!store.objectStoreNames.contains('songs')) store.createObjectStore('songs', { keyPath: 'id' });
      if (!store.objectStoreNames.contains('drops')) store.createObjectStore('drops', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function save(storeName, value) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function remove(storeName, id) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = String(wholeSeconds % 60).padStart(2, '0');
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

function formatClipTime(seconds) {
  return `${formatTime(seconds)}.${Math.floor((seconds % 1) * 10)}`;
}

function formatDate(timestamp) {
  return dropDateFormatter.format(timestamp);
}

function getDropPoint(drop) {
  return drop.dropPoint ?? drop.clipStart ?? 0;
}

function playbackStartAt(drop) {
  return drop.scheduledAt - getDropPoint(drop) * 1000;
}

function updateDropDisplay() {
  dropPointLabel.textContent = formatClipTime(dropPoint);
  const ready = Boolean(currentSong && currentSong.duration > 0);
  markDropButton.disabled = !ready;
  scheduleButton.disabled = !ready;
}

function renderCurrentSong() {
  const hasSong = Boolean(currentSong);
  emptySong.hidden = hasSong;
  songEditor.hidden = !hasSong;
  scheduleButton.disabled = !hasSong || !currentSong.duration;
  if (!hasSong) return;

  songName.textContent = currentSong.name;
  songDuration.textContent = currentSong.duration ? `${formatTime(currentSong.duration)} total` : 'Loading audio…';
  if (loadedSongId === currentSong.id) return;

  player.pause();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(currentSong.audio);
  loadedSongId = currentSong.id;
  player.src = activeObjectUrl;
  player.load();
}

function renderDrops() {
  dropList.replaceChildren();
  const visibleDrops = drops.filter((drop) => ['scheduled', 'playing'].includes(drop.status));
  emptyDrops.hidden = visibleDrops.length > 0;
  for (const drop of [...visibleDrops].sort((a, b) => a.scheduledAt - b.scheduledAt)) {
    const item = document.createElement('li');
    item.className = 'drop-item';
    const icon = document.createElement('span');
    icon.className = 'drop-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '♪';

    const details = document.createElement('div');
    details.className = 'drop-details';
    const title = document.createElement('strong');
    title.textContent = drop.name || drop.songName || 'Untitled drop';
    const subtitle = document.createElement('span');
    subtitle.textContent = `${drop.songName || 'Song'} · drop ${formatClipTime(getDropPoint(drop))}`;
    details.append(title, subtitle);

    const time = document.createElement('time');
    time.className = 'drop-time';
    time.dateTime = new Date(drop.scheduledAt).toISOString();
    time.textContent = formatDate(drop.scheduledAt);
    const status = document.createElement('span');
    status.className = `drop-status status-${drop.status}`;
    status.textContent = drop.status;
    item.append(icon, details, time, status);

    if (drop.status === 'scheduled') {
      const cancel = document.createElement('button');
      cancel.className = 'text-button';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelDrop(drop.id));
      item.append(cancel);
    }
    dropList.append(item);
  }
}

async function refresh() {
  const [loadedSongs, loadedDrops] = await Promise.all([getAll('songs'), getAll('drops')]);
  songs = loadedSongs;
  drops = loadedDrops.filter((drop) => ['scheduled', 'playing'].includes(drop.status));
  for (const drop of loadedDrops) {
    if (!['scheduled', 'playing'].includes(drop.status)) await remove('drops', drop.id);
  }
  const selectedId = localStorage.getItem('droppr-current-song');
  currentSong = songs.find((song) => song.id === selectedId)
    ?? [...songs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  if (currentSong) localStorage.setItem('droppr-current-song', currentSong.id);
  renderCurrentSong();
  renderDrops();
}

async function pruneUnusedSongs() {
  const scheduledIds = new Set(drops.filter((drop) => ['scheduled', 'playing'].includes(drop.status)).map((drop) => drop.songId));
  for (const song of songs) {
    if (song.id !== currentSong?.id && !scheduledIds.has(song.id)) await remove('songs', song.id);
  }
  await refresh();
}

async function cancelDrop(id) {
  const drop = drops.find((item) => item.id === id);
  if (!drop || drop.status !== 'scheduled') return;
  const scheduled = scheduledSources.get(id);
  if (scheduled) {
    scheduledSources.delete(id);
    clearTimeout(scheduled.startTimer);
    clearTimeout(scheduled.dropTimer);
    scheduled.source.onended = null;
    scheduled.source.stop();
  }
  drops = drops.filter((item) => item.id !== id);
  renderDrops();
  await remove('drops', id);
  await pruneUnusedSongs();
}

async function decodeSong(song) {
  if (decodedAudio.has(song.id)) return decodedAudio.get(song.id);
  const buffer = await audioContext.decodeAudioData(await song.audio.arrayBuffer());
  decodedAudio.set(song.id, buffer);
  return buffer;
}

async function armScheduledDrop(drop) {
  if (!playbackEnabled || scheduledSources.has(drop.id) || armingDrops.has(drop.id) || drop.status !== 'scheduled') return;
  const song = songs.find((item) => item.id === drop.songId);
  if (!song) {
    playbackStatus.textContent = `The audio for “${drop.name || drop.songName}” is unavailable.`;
    return;
  }

  armingDrops.add(drop.id);
  try {
    const buffer = await decodeSong(song);
    if (drop.status !== 'scheduled' || scheduledSources.has(drop.id)) return;

    const targetStart = playbackStartAt(drop);
    const now = Date.now();
    const elapsedBeforeStart = Math.max(0, (now - targetStart) / 1000);
    const startOffset = Math.min(getDropPoint(drop), elapsedBeforeStart);
    const delay = Math.max(0, (targetStart - now) / 1000);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const scheduled = { source, startTimer: null, dropTimer: null };
    scheduledSources.set(drop.id, scheduled);
    scheduled.startTimer = window.setTimeout(async () => {
      if (scheduledSources.get(drop.id) !== scheduled) return;
      drop.status = 'playing';
      await save('drops', drop);
      await refresh();
      playbackStatus.textContent = `Playing ${drop.songName}`;
    }, Math.max(0, targetStart - Date.now()));
    scheduled.dropTimer = window.setTimeout(() => {
      if (scheduledSources.get(drop.id) === scheduled) playbackStatus.textContent = `Drop moment: ${drop.songName}`;
    }, Math.max(0, drop.scheduledAt - Date.now()));
    source.onended = async () => {
      if (scheduledSources.get(drop.id) !== scheduled) return;
      scheduledSources.delete(drop.id);
      clearTimeout(scheduled.startTimer);
      clearTimeout(scheduled.dropTimer);
      drops = drops.filter((item) => item.id !== drop.id);
      renderDrops();
      await remove('drops', drop.id);
      playbackStatus.textContent = `Finished ${drop.songName}.`;
      await pruneUnusedSongs();
    };

    source.start(audioContext.currentTime + delay, startOffset);
  } catch (error) {
    playbackStatus.textContent = `Could not prepare ${song.name}: ${error.message}`;
  } finally {
    armingDrops.delete(drop.id);
  }
}

async function armScheduledDrops() {
  if (!playbackEnabled) return;
  for (const drop of drops.filter((item) => item.status === 'scheduled')) {
    await armScheduledDrop(drop);
  }
}

async function checkSchedule() {
  clockElement.textContent = clockFormatter.format(new Date());
  const due = [...drops]
    .filter((drop) => drop.status === 'scheduled' && playbackStartAt(drop) <= Date.now())
    .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
  if (due && !playbackEnabled) {
    playbackStatus.textContent = `“${due.name || due.songName}” is waiting. Enable playback to start it now.`;
    return;
  }
  await armScheduledDrops();
}

songFileInput.addEventListener('change', async () => {
  const file = songFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    playbackStatus.textContent = 'Choose a supported audio file.';
    songFileInput.value = '';
    return;
  }
  player.pause();
  const song = { id: crypto.randomUUID(), name: file.name, audio: file, duration: 0, createdAt: Date.now() };
  await save('songs', song);
  localStorage.setItem('droppr-current-song', song.id);
  currentSong = song;
  loadedSongId = null;
  dropInitializedSongId = null;
  dropPoint = 0;
  songFileInput.value = '';
  await refresh();
  await pruneUnusedSongs();
  playbackStatus.textContent = 'Song imported. Find the drop point and mark it at the playhead.';
});

document.querySelector('#replace-song').addEventListener('click', () => songFileInput.click());

player.addEventListener('loadedmetadata', async () => {
  if (!currentSong || loadedSongId !== currentSong.id) return;
  currentSong.duration = player.duration;
  await save('songs', currentSong);
  if (dropInitializedSongId !== currentSong.id) {
    dropPoint = 0;
    dropInitializedSongId = currentSong.id;
  }
  songDuration.textContent = `${formatTime(player.duration)} total`;
  markDropButton.disabled = false;
  updateDropDisplay();
});

markDropButton.addEventListener('click', () => {
  dropPoint = Math.min(currentSong?.duration ?? player.currentTime, Math.max(0, player.currentTime));
  updateDropDisplay();
});

dropForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentSong || !currentSong.duration) return;
  const scheduledAt = new Date(dropTimeInput.value).getTime();
  if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
    playbackStatus.textContent = 'Choose a future local date and time.';
    return;
  }
  const startAt = scheduledAt - dropPoint * 1000;
  if (startAt <= Date.now() + 500) {
    playbackStatus.textContent = 'Choose a later time so the song can start before the drop point.';
    return;
  }
  pendingDrop = {
    id: crypto.randomUUID(),
    name: currentSong.name,
    songId: currentSong.id,
    songName: currentSong.name,
    dropPoint,
    scheduledAt,
    status: 'scheduled',
  };
  warningCopy.textContent = `Keep this tab open. The song starts ${formatTime(dropPoint)} before ${formatDate(scheduledAt)} so the marked point lands on time.`;
  scheduleWarning.showModal();
});

async function savePendingDrop(audioReady) {
  if (!pendingDrop) return;
  if (playbackStartAt(pendingDrop) <= Date.now() + 500) {
    warningCopy.textContent = 'There is not enough time for the song to start first. Go back and choose a later time.';
    return;
  }
  await save('drops', pendingDrop);
  pendingDrop = null;
  scheduleWarning.close();
  dropForm.reset();
  await refresh();
  playbackStatus.textContent = audioReady
    ? 'Drop scheduled. Playback is enabled for this tab.'
    : 'Drop scheduled. Enable playback before the song start time.';
  await checkSchedule();
}

cancelScheduleButton.addEventListener('click', () => {
  pendingDrop = null;
  scheduleWarning.close();
});

scheduleWithoutPlaybackButton.addEventListener('click', () => savePendingDrop(false));

enableAndScheduleButton.addEventListener('click', async () => {
  const audioReady = await enableScheduledPlayback();
  if (audioReady) await savePendingDrop(true);
  else warningCopy.textContent = 'Playback could not be enabled. Check your browser audio settings or schedule without playback.';
});

async function enableScheduledPlayback() {
  if (playbackEnabled) return true;
  if (!currentSong) {
    playbackStatus.textContent = 'Import a song before enabling playback.';
    return false;
  }
  try {
    const AudioContextType = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextType) throw new Error('Web Audio is not supported in this browser.');
    audioContext ??= new AudioContextType();
    await audioContext.resume();
    if (audioContext.state !== 'running') throw new Error('Audio playback is still blocked.');
    playbackEnabled = true;
    enablePlaybackButton.disabled = true;
    enablePlaybackButton.textContent = 'Playback enabled';
    return true;
  } catch (error) {
    playbackStatus.textContent = `Playback could not be enabled: ${error.message}`;
    return false;
  }
}

enablePlaybackButton.addEventListener('click', async () => {
  if (await enableScheduledPlayback()) {
    playbackStatus.textContent = 'Playback is enabled for this tab.';
    await checkSchedule();
  }
});

try {
  database = await openDatabase();
  const oldDrops = await getAll('drops');
  for (const drop of oldDrops) {
    if (drop.status === 'playing') {
      drop.status = 'scheduled';
      await save('drops', drop);
    }
  }
  await refresh();
  if (drops.some((drop) => drop.status === 'scheduled')) {
    playbackStatus.textContent = 'Enable playback before the clip starts. This tab must stay open.';
  } else if (currentSong) {
    playbackStatus.textContent = 'Song ready. Find the drop point and mark it at the playhead.';
  }
  await checkSchedule();
  // Use a short polling interval: Web Audio remains responsible for the exact start time.
  window.setInterval(() => checkSchedule().catch((error) => {
    playbackStatus.textContent = `Scheduler error: ${error.message}`;
  }), 250);
} catch (error) {
  playbackStatus.textContent = `Could not open local storage: ${error.message}`;
}const databaseName = 'droppr';
const databaseVersion = 1;
