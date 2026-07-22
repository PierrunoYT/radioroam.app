const audio = document.querySelector('#audio');
const ipod = document.querySelector('.ipod');
const list = document.querySelector('#station-list');
const playButton = document.querySelector('#play');
const artwork = document.querySelector('#artwork');
const favoriteButton = document.querySelector('#favorite-current');
const favoritesNav = document.querySelector('#favorites-button');
const volume = document.querySelector('#volume');

let stations = [];
let currentIndex = -1;
let currentStation = null;
let favorites = JSON.parse(localStorage.getItem('radio-player-favorites') || '[]');
let toastTimer;
let streamCandidates = [];
let streamCandidateIndex = -1;
let shouldBePlaying = false;

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function renderStations(items, title = 'On the air') {
  stations = items.filter(station => station.id);
  document.querySelector('#results-title').textContent = title;
  document.querySelector('#results-count').textContent = `${stations.length} stations`;
  if (!stations.length) {
    list.innerHTML = '<div class="empty">No stations found. Try another search.</div>';
    return;
  }

  list.innerHTML = stations.map((station, index) => `
    <button class="station ${currentStation?.id === station.id ? 'active' : ''}" data-index="${index}" type="button">
      ${station.image
        ? `<img class="station-image" src="${escapeHtml(station.image)}" alt="" loading="lazy">`
        : '<span class="station-image"></span>'}
      <span class="station-copy">
        <span class="station-name">${escapeHtml(station.name)}</span>
        <span class="station-meta">${escapeHtml(station.subtext || station.formats || 'Live radio')}</span>
      </span>
      <span class="station-play">▶</span>
    </button>`).join('');
}

function setLoading() {
  list.innerHTML = '<div class="loading-state"><span></span><span></span><span></span></div>';
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
    streamCandidates = data.urls?.length ? data.urls : [data.url];
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
  artwork.style.backgroundImage = currentStation.image ? `url("${currentStation.image.replaceAll('"', '%22')}")` : '';
  artwork.classList.toggle('has-image', Boolean(currentStation.image));
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
  localStorage.setItem('radio-player-favorites', JSON.stringify(favorites));
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
  list.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
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
