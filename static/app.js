const audio = document.querySelector('#audio');
const ipod = document.querySelector('.ipod');
const list = document.querySelector('#station-list');
const playButton = document.querySelector('#play');
const artwork = document.querySelector('#artwork');
const favoriteButton = document.querySelector('#favorite-current');
const favoritesNav = document.querySelector('#favorites-button');
const volume = document.querySelector('#volume');
const favoritesKey = 'radio-roam-favorites';
const themeKey = 'radio-roam-theme';
const themeToggle = document.querySelector('#theme-toggle');

let stations = [];
let currentIndex = -1;
let currentStation = null;
let favorites = loadFavorites();
let toastTimer;
let streamCandidates = [];
let streamCandidateIndex = -1;
let shouldBePlaying = false;

function loadFavorites() {
  try {
    const value = JSON.parse(
      localStorage.getItem(favoritesKey) ||
      localStorage.getItem('radio-player-favorites') ||
      '[]'
    );
    return Array.isArray(value) ? value.filter(station => station && typeof station === 'object') : [];
  } catch {
    return [];
  }
}

function updateThemeToggle() {
  const isDark = document.documentElement.dataset.theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
  document.querySelector('meta[name="theme-color"]').content = isDark ? '#171716' : '#e9e6e1';
}

themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(themeKey, theme);
  updateThemeToggle();
});
updateThemeToggle();

function safeRemoteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Around a third of stations publish no artwork, so build a stable stand-in
// from the name: its first character over a hue derived from the whole string,
// which keeps the same station the same color every time it's listed.
function initialTile(name = '') {
  name = String(name);
  const letter = [...name.trim()][0] || '?';
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)) % 360;
  const tile = document.createElement('span');
  tile.className = 'station-image station-initial';
  tile.style.setProperty('--tile-hue', hash);
  tile.textContent = letter.toUpperCase();
  return tile;
}

function stationNode(station, index) {
  const button = document.createElement('button');
  button.className = `station${currentStation?.id === station.id ? ' active' : ''}`;
  button.dataset.index = index;
  button.type = 'button';

  const imageUrl = safeRemoteUrl(station.image);
  if (imageUrl) {
    const image = document.createElement('img');
    image.className = 'station-image';
    image.src = imageUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.dataset.name = String(station.name || '');
    button.append(image);
  } else {
    button.append(initialTile(station.name));
  }

  const copy = document.createElement('span');
  copy.className = 'station-copy';
  const name = document.createElement('span');
  name.className = 'station-name';
  name.textContent = String(station.name || 'Unknown station');
  const metadata = document.createElement('span');
  metadata.className = 'station-meta';
  metadata.textContent = String(station.subtext || station.formats || 'Live radio');
  copy.append(name, metadata);

  const play = document.createElement('span');
  play.className = 'station-play';
  play.textContent = '▶';
  button.append(copy, play);
  return button;
}

function renderStations(items, title = 'On the air') {
  stations = Array.isArray(items) ? items.filter(station => station?.id) : [];
  document.querySelector('#results-title').textContent = title;
  document.querySelector('#results-count').textContent = `${stations.length} stations`;
  if (!stations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No stations found. Try another search.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...stations.map(stationNode));
}

function setLoading() {
  const loading = document.createElement('div');
  loading.className = 'loading-state';
  loading.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  list.replaceChildren(loading);
  document.querySelector('#results-count').textContent = '';
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function browse(category = 'music') {
  setLoading();
  try {
    const items = await getJson(`/api/browse?category=${encodeURIComponent(category)}`);
    renderStations(items, category === 'local' ? 'Near you' : `${category} radio`);
  } catch (error) {
    showError(error.message);
  }
}

async function selectStation(index, autoplay = true) {
  const station = stations[index];
  if (!station) return;
  currentIndex = index;
  currentStation = station;
  updatePlayer();
  document.querySelectorAll('.station').forEach((node, nodeIndex) => node.classList.toggle('active', nodeIndex === index));

  document.querySelector('#now-status').textContent = 'TUNING…';
  try {
    const data = await getJson(`/api/stream/${encodeURIComponent(station.id)}`);
    const candidates = data.urls?.length ? data.urls : [data.url];
    streamCandidates = candidates.map(safeRemoteUrl).filter(Boolean);
    if (!streamCandidates.length) throw new Error('No playable stream was found.');
    streamCandidateIndex = 0;
    shouldBePlaying = autoplay;
    audio.src = streamCandidates[streamCandidateIndex];
    document.querySelector('#now-status').textContent = 'NOW BROADCASTING';
    if (autoplay) await audio.play();
  } catch (error) {
    document.querySelector('#now-status').textContent = 'OFF AIR';
    showToast(error.name === 'NotAllowedError' ? 'Press play to start listening.' : error.message);
  }
}

function updatePlayer() {
  if (!currentStation) return;
  document.querySelector('#now-name').textContent = currentStation.name;
  document.querySelector('#now-subtext').textContent = currentStation.subtext || currentStation.formats || 'Live radio';
  const imageUrl = safeRemoteUrl(currentStation.image);
  artwork.style.backgroundImage = imageUrl ? `url("${imageUrl}")` : '';
  artwork.classList.toggle('has-image', Boolean(imageUrl));
  favoriteButton.classList.toggle('active', isFavorite(currentStation.id));
  favoriteButton.textContent = isFavorite(currentStation.id) ? '♥' : '♡';
}

function isFavorite(id) { return favorites.some(station => station.id === id); }

function toggleFavorite() {
  if (!currentStation) return showToast('Choose a station first.');
  if (isFavorite(currentStation.id)) {
    favorites = favorites.filter(station => station.id !== currentStation.id);
    showToast('Removed from favorites');
  } else {
    favorites.push(currentStation);
    showToast('Saved to favorites');
  }
  localStorage.setItem(favoritesKey, JSON.stringify(favorites));
  updatePlayer();
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

function showError(message) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  list.replaceChildren(empty);
  showToast(message);
}

function step(direction) {
  if (!stations.length) return;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + stations.length) % stations.length;
  selectStation(nextIndex);
}

document.querySelector('#search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const query = document.querySelector('#search-input').value.trim();
  if (!query) return;
  document.querySelectorAll('.category').forEach(button => button.classList.remove('active'));
  setLoading();
  try {
    renderStations(await getJson(`/api/search?q=${encodeURIComponent(query)}`), `Results for “${query}”`);
  } catch (error) { showError(error.message); }
});

document.querySelector('.categories').addEventListener('click', event => {
  const button = event.target.closest('.category');
  if (!button) return;
  document.querySelectorAll('.category').forEach(item => item.classList.toggle('active', item === button));
  browse(button.dataset.category);
});

list.addEventListener('click', event => {
  const station = event.target.closest('.station');
  if (station) selectStation(Number(station.dataset.index));
});

// Plenty of the published favicon URLs are dead. Listen during capture, since
// image errors don't bubble, and swap the broken image for a letter tile.
list.addEventListener('error', event => {
  const image = event.target;
  if (image.tagName !== 'IMG' || !image.classList.contains('station-image')) return;
  image.replaceWith(initialTile(image.dataset.name || ''));
}, true);

playButton.addEventListener('click', () => {
  if (!currentStation) return selectStation(0);
  if (audio.paused) {
    shouldBePlaying = true;
    audio.play().catch(error => showToast(error.message));
  } else {
    shouldBePlaying = false;
    audio.pause();
  }
});
document.querySelector('#previous').addEventListener('click', () => step(-1));
document.querySelector('#next').addEventListener('click', () => step(1));
favoriteButton.addEventListener('click', toggleFavorite);
favoritesNav.addEventListener('click', () => renderStations(favorites, 'Your favorites'));

document.querySelector('.menu-button').addEventListener('click', () => {
  document.querySelector('#search-input').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.querySelector('#mute').addEventListener('click', () => {
  audio.muted = !audio.muted;
  document.querySelector('#mute').textContent = audio.muted ? '×' : '−';
  document.querySelector('.volume-bar').classList.toggle('visible');
});
volume.addEventListener('input', () => { audio.volume = Number(volume.value); audio.muted = false; });
audio.volume = Number(volume.value);
audio.addEventListener('play', () => ipod.classList.add('playing'));
audio.addEventListener('pause', () => ipod.classList.remove('playing'));
audio.addEventListener('error', () => {
  ipod.classList.remove('playing');
  if (!audio.src) return;
  if (streamCandidateIndex + 1 < streamCandidates.length) {
    streamCandidateIndex += 1;
    document.querySelector('#now-status').textContent = 'TRYING ANOTHER SIGNAL…';
    audio.src = streamCandidates[streamCandidateIndex];
    if (shouldBePlaying) audio.play().catch(() => {});
    return;
  }
  document.querySelector('#now-status').textContent = 'UNSUPPORTED STREAM';
  showToast('This station has no browser-compatible stream. Try another station.');
});

function updateClock() {
  document.querySelector('#clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 30000);
browse();
