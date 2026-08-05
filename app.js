const firebaseConfig = window.firebaseConfig || {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const TEAMS = {
  team1: { name: 'Team 1', color: '#e53935', emoji: 'ðŸ”´' },
  team2: { name: 'Team 2', color: '#1e88e5', emoji: 'ðŸ”µ' },
  team3: { name: 'Team 3', color: '#43a047', emoji: 'ðŸŸ¢' }
};

// ---- Game constants ----
const FLOP_SIZE = 9;
const PRIVATE_CARD_COUNT = 5;
const WILDCARD_IDS = ['wildcard-parks', 'wildcard-rivers', 'wildcard-coastline'];
const WILDCARD_LABELS = {
  'wildcard-parks': 'Parks Wild Card',
  'wildcard-rivers': 'Rivers Wild Card',
  'wildcard-coastline': 'Coastline Wild Card'
};
// ---- Device role (persisted locally; NOT synced â€” this is what makes
//      private cards "private" to whichever device picked that team).
//      There is no Game Master role: every device can claim any team's
//      turf, manage the Flop, and reveal/remove/add Flop cards. ----
let myRole = localStorage.getItem('tnc_role') || null; // 'team1'|'team2'|'team3'
let currentMode = 'team1'; // who a map tap claims for; any device can change this

let claims = {};
let firebaseReady = false;
let firebaseConfigured = false;
let claimsRef = null;
let flopRef = null;
let privateRef = null;
let gameSeed = null;

let ELIGIBLE_IDS = [];
let nameById = {};
let loadedGeoData = null;

function isFirebaseConfigured() {
  return !!firebaseConfig &&
    typeof firebaseConfig === 'object' &&
    firebaseConfig.apiKey &&
    !String(firebaseConfig.apiKey).startsWith('YOUR_') &&
    !String(firebaseConfig.apiKey).startsWith('PASTE_');
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem('tnc_game_state_v1');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Could not load local game state', e);
    return null;
  }
}

function savePersistedState() {
  try {
    localStorage.setItem('tnc_game_state_v1', JSON.stringify({
      claims,
      flop,
      flopRevealed,
      privateState,
      gameSeed
    }));
  } catch (e) {
    console.warn('Could not save local game state', e);
  }
}

function createSeededRandom(seed) {
  let state = Number(seed) || 0;
  return function() {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  }
}

function shuffleArray(array, seed = null) {
  const copy = [...array];
  const random = seed === null || seed === undefined
    ? Math.random
    : createSeededRandom(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getGameSeed() {
  if (gameSeed !== null && gameSeed !== undefined) return gameSeed;
  const persistedState = loadPersistedState();
  if (persistedState && Number.isInteger(persistedState.gameSeed)) {
    gameSeed = persistedState.gameSeed;
  }
  return gameSeed;
}

function createGameSeed() {
  return Date.now() + Math.floor(Math.random() * 1000000000);
}

function setGameSeed(seed) {
  gameSeed = seed;
  savePersistedState();
  return gameSeed;
}

function getReservedPrivateIds(state = privateState) {
  return Object.values(state)
    .filter(Boolean)
    .flatMap(teamState => Array.isArray(teamState.hand) ? teamState.hand : []);
}

function isReservedPrivateCard(id) {
  return getReservedPrivateIds(privateState).includes(id);
}

function normalizePrivateState(raw) {
  const normalized = {};
  Object.keys(TEAMS).forEach(team => {
    const teamState = raw && raw[team] ? raw[team] : {};
    normalized[team] = {
      hand: Array.isArray(teamState.hand) && teamState.hand.length === PRIVATE_CARD_COUNT
        ? teamState.hand
        : [],
      revealed: Number.isInteger(teamState.revealed) ? teamState.revealed : 0,
      used: Array.isArray(teamState.used) ? teamState.used : [],
      lastReveal: Number.isInteger(teamState.lastReveal) ? teamState.lastReveal : 0
    };
  });
  return normalized;
}

function buildFreshPrivateState(excludedIds = [], seed = getGameSeed()) {
  const excludedSet = new Set(excludedIds);
  const available = shuffleArray(
    PLAYABLE_NEIGHBOURHOOD_IDS.filter(id => !excludedSet.has(id)),
    seed
  );
  const nextState = {};

  Object.keys(TEAMS).forEach((team, index) => {
    const start = index * PRIVATE_CARD_COUNT;
    nextState[team] = {
      hand: available.slice(start, start + PRIVATE_CARD_COUNT),
      revealed: 0,
      used: [],
      lastReveal: 0
    };
  });

  return nextState;
}

function ensurePrivateHands(raw) {
  const state = normalizePrivateState(raw);
  const existingHandIds = new Set(getReservedPrivateIds(state));
  const missingTeams = Object.keys(TEAMS).filter(team => state[team].hand.length !== PRIVATE_CARD_COUNT);
  if (missingTeams.length === 0) {
    return state;
  }

  const excludedIds = [
    ...existingHandIds,
    ...Object.keys(claims),
    ...flop
  ];
  const seed = getGameSeed() || createGameSeed();
  setGameSeed(seed);
  const nextState = {
    ...state,
    ...buildFreshPrivateState(excludedIds, seed)
  };

  if (privateRef) privateRef.set(nextState);
  return nextState;
}

// ---- The playable pool ----
// 64 neighbourhoods total, minus the 15 private-card reserve slots, plus 3 wildcards.
const ALL_NEIGHBOURHOOD_IDS = ['085','087','114','089','111','115','112','110','108','090','088','086','091','093','083','084','082','081','080','092','109','107','094','095','079','078','077','076','096','106','102','101','097','098','075','073','071','074','056','099','104','100','103','041','042','044','043','054','058','057','059','060','066','067','068','069','065','064','062','063','070','061','072','055'];
const PRIVATE_RESERVE_COUNT = 15;
const PLAYABLE_NEIGHBOURHOOD_IDS = ALL_NEIGHBOURHOOD_IDS.slice(0, ALL_NEIGHBOURHOOD_IDS.length - PRIVATE_RESERVE_COUNT);
let flop = [];              // current flop array (ids). Empty = not revealed yet.
let flopRevealed = false;
let privateState = {};
let privateTickTimer = null;

const persistedState = loadPersistedState();
if (persistedState) {
  claims = persistedState.claims || {};
  flop = Array.isArray(persistedState.flop) ? persistedState.flop : [];
  flopRevealed = !!persistedState.flopRevealed;
  privateState = normalizePrivateState(persistedState.privateState || {});
  if (persistedState.gameSeed !== undefined && persistedState.gameSeed !== null) {
    gameSeed = persistedState.gameSeed;
  }
} else {
  privateState = ensurePrivateHands({});
}

const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 1800);
}

// ---------- role handling ----------
function openRoleOverlay() {
  document.getElementById('role-overlay').classList.add('show');
}

function setRole(role) {
  myRole = role;
  localStorage.setItem('tnc_role', role);
  document.getElementById('role-overlay').classList.remove('show');
  applyRoleUI();
  renderPrivateCardsList();
  renderFlopGrid();
}

function applyRoleUI() {
  const tag = document.getElementById('role-tag');
  if (myRole && TEAMS[myRole]) {
    tag.textContent = TEAMS[myRole].emoji + ' ' + TEAMS[myRole].name;
    tag.style.background = TEAMS[myRole].color;
  } else {
    tag.textContent = 'Set role';
    tag.style.background = '#1f2d1f';
  }

  const resetBtn = document.getElementById('reset-game-btn');
  if (resetBtn) {
    resetBtn.style.display = myRole === 'team1' ? 'inline-block' : 'none';
  }

  // Anyone can claim for any team, so default the acting team to
  // whichever team this device picked (falls back to team1).
  if (!currentMode || currentMode === 'clear') {
    currentMode = (myRole && TEAMS[myRole]) ? myRole : 'team1';
  }
  ['team1','team2','team3'].forEach(t => {
    const b1 = document.getElementById('btn-' + t);
    const b2 = document.getElementById('btn-' + t + '-game');
    if (b1) b1.classList.toggle('active', t === currentMode);
    if (b2) b2.classList.toggle('active', t === currentMode);
  });

  if (!myRole) openRoleOverlay();
}

// ---------- screen switching ----------
function showScreen(which) {
  document.getElementById('map-screen').classList.toggle('active', which === 'map');
  document.getElementById('game-screen').classList.toggle('active', which === 'game');
  document.getElementById('nav-map').classList.toggle('active', which === 'map');
  document.getElementById('nav-game').classList.toggle('active', which === 'game');
  if (which === 'game') {
    document.getElementById('nav-badge').classList.remove('show');
  }
  if (which === 'map' && typeof map !== 'undefined' && map) {
    setTimeout(() => map.invalidateSize(), 50);
  }
}

function initFirebase() {
  firebaseConfigured = isFirebaseConfigured();
  if (!firebaseConfigured) {
    setStatus('Using local save only', 'connected');
    savePersistedState();
    renderFlopGrid();
    renderPrivateCardsList();
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    claimsRef = firebase.database().ref('claims');
    flopRef = firebase.database().ref('flop');       // { revealed: bool, ids: [...] }
    privateRef = firebase.database().ref('privateCards');

    claimsRef.on('value', (snapshot) => {
      claims = snapshot.val() || {};
      firebaseReady = true;
      savePersistedState();
      setStatus('Live â€” synced', 'connected');
      repaintAllClaims();
      renderFlopGrid();
    }, (err) => {
      setStatus('Connection error', 'error');
      console.error(err);
    });

    flopRef.on('value', (snapshot) => {
      const val = snapshot.val();
      if (val && typeof val === 'object') {
        flop = Array.isArray(val.ids) ? val.ids : [];
        flopRevealed = !!val.revealed;
        if (val.seed !== undefined && val.seed !== null) {
          gameSeed = val.seed;
        }
      } else {
        flop = [];
        flopRevealed = false;
      }
      savePersistedState();
      renderFlopGrid();
    });

    privateRef.on('value', (snapshot) => {
      const val = snapshot.val() || {};
      privateState = ensurePrivateHands(val);
      savePersistedState();
      renderPrivateCardsList();
    });

    if (!privateTickTimer) {
      privateTickTimer = setInterval(renderPrivateCardsList, 15000);
    }
  } catch (e) {
    setStatus('Firebase init failed', 'error');
    console.error(e);
  }
}

function setStatus(msg, cls) {
  const a = document.getElementById('status-banner');
  const b = document.getElementById('game-status-banner');
  [a, b].forEach(el => {
    if (!el) return;
    el.textContent = msg;
    el.className = '';
    if (cls) el.classList.add(cls);
    el.classList.add('show');
  });
}

// Any device can change "claiming as" â€” there's no Game Master.
function setActingTeam(mode) {
  currentMode = mode;
  ['team1', 'team2', 'team3'].forEach(t => {
    const b1 = document.getElementById('btn-' + t);
    const b2 = document.getElementById('btn-' + t + '-game');
    if (b1) b1.classList.toggle('active', t === mode);
    if (b2) b2.classList.toggle('active', t === mode);
  });
  const c1 = document.getElementById('btn-clear-map');
  const c2 = document.getElementById('btn-clear-map-game');
  if (c1) c1.classList.toggle('active', mode === 'clear');
  if (c2) c2.classList.toggle('active', mode === 'clear');
  renderPrivateCardsList();
}

function claimNeighbourhood(id, name) {
  if (!myRole) { openRoleOverlay(); return; }

  if (currentMode === 'clear') {
    delete claims[id];
    savePersistedState();
    if (claimsRef && firebaseReady) claimsRef.child(id).remove();
    repaintAllClaims();
    renderFlopGrid();
    showToast(name + ' â€” cleared');
    return;
  }

  if (claims[id]) {
    showToast(name + ' is already claimed');
    return;
  }

  claims[id] = currentMode;
  savePersistedState();
  if (claimsRef && firebaseReady) claimsRef.child(id).set(currentMode);
  repaintAllClaims();
  renderFlopGrid();
  showToast(name + ' â†’ ' + TEAMS[currentMode].name);
}

// ---- Flop logic (open to any device â€” no Game Master) ----
// The Flop is always drawn from the fixed 64-card FLOP_POOL_IDS deck.

function remainingPool() {
  const inFlopSet = new Set(flop);
  const reservedSet = new Set(getReservedPrivateIds());
  return PLAYABLE_NEIGHBOURHOOD_IDS.filter(id => !inFlopSet.has(id) && !reservedSet.has(id) && !claims[id]);
}

function drawOne() {
  const pool = remainingPool();
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function saveFlop() {
  savePersistedState();
  if (flopRef && firebaseReady) {
    flopRef.set({ revealed: flopRevealed, ids: flop, seed: getGameSeed() });
  }
}

function buildFreshFlop(seed = getGameSeed()) {
  const random = seed === null || seed === undefined
    ? Math.random
    : createSeededRandom(seed);
  const wildcardCount = Math.floor(random() * (WILDCARD_IDS.length + 1));
  const selectedWildcards = shuffleArray([...WILDCARD_IDS], seed + 1).slice(0, wildcardCount);
  const regularCards = shuffleArray(PLAYABLE_NEIGHBOURHOOD_IDS, seed + 2).slice(0, FLOP_SIZE - selectedWildcards.length);
  return shuffleArray([...selectedWildcards, ...regularCards], seed + 3);
}

function getFlopCardLabel(id) {
  return WILDCARD_LABELS[id] || nameById[id] || id;
}

function resetGame() {
  if (myRole !== 'team1') {
    showToast('Only Team 1 can reset the game');
    return;
  }

  const confirmed = window.confirm('Reset the whole game? This will clear all claims, flop cards, and private cards.');
  if (!confirmed) {
    return;
  }

  const nextSeed = createGameSeed();
  setGameSeed(nextSeed);
  const freshFlop = buildFreshFlop(nextSeed);
  const freshPrivateState = buildFreshPrivateState(freshFlop, nextSeed);

  claims = {};
  flop = freshFlop;
  flopRevealed = false;
  privateState = freshPrivateState;

  savePersistedState();
  if (claimsRef && firebaseReady) claimsRef.set({});
  if (flopRef && firebaseReady) flopRef.set({ revealed: false, ids: flop, seed: nextSeed });
  if (privateRef && firebaseReady) privateRef.set(privateState);

  repaintAllClaims();
  renderFlopGrid();
  renderPrivateCardsList();
  showToast('Game reset â€” fresh flop and private cards');
}

function revealFlop() {
  const pool = remainingPool();
  if (pool.length + WILDCARD_IDS.length < FLOP_SIZE) {
    showToast('Not enough cards available to reveal the Flop');
    return;
  }
  const nextSeed = getGameSeed() || createGameSeed();
  setGameSeed(nextSeed);
  const freshFlop = buildFreshFlop(nextSeed);
  const freshPrivateState = buildFreshPrivateState(freshFlop, nextSeed);
  flop = freshFlop;
  flopRevealed = true;
  privateState = freshPrivateState;
  saveFlop();
  if (privateRef && firebaseReady) privateRef.set(privateState);
  renderFlopGrid();
  renderPrivateCardsList();
  showToast('The Flop is revealed!');
}

function removeFromFlop(id) {
  flop = flop.filter(x => x !== id);
  saveFlop();
  renderFlopGrid();
  showToast('Removed #' + id + ' from the Flop');
}

function addCardToFlop() {
  if (flop.length >= FLOP_SIZE) { showToast('Flop is already full'); return; }
  const next = drawOne();
  if (!next) { showToast('No more neighbourhoods left to draw'); return; }
  flop = [...flop, next];
  saveFlop();
  renderFlopGrid();
  showToast('Added ' + (nameById[next] || next) + ' to the Flop');
}

function renderFlopGrid() {
  const grid = document.getElementById('flop-grid');
  const revealWrap = document.getElementById('flop-reveal-wrap');
  const addBtn = document.getElementById('add-card-btn');
  const sub = document.getElementById('flop-sub');
  if (!grid || !revealWrap) return;

  if (!flopRevealed) {
    grid.innerHTML = '';
    addBtn.style.display = 'none';
    sub.textContent = 'Tap below to randomly draw 9 neighbourhoods into play.';
    revealWrap.innerHTML = '<button class="reveal-flop-btn" onclick="revealFlop()">ðŸŽ² Reveal the Flop</button>';
    if (typeof layerById !== 'undefined') repaintAllClaims();
    return;
  }

  revealWrap.innerHTML = '';
  sub.textContent = 'Any neighbourhood can be claimed once the Flop is revealed. Wildcards are included in the Flop and cannot appear in private hands.';
  grid.innerHTML = '';
  flop.forEach(id => {
    const wrap = document.createElement('div');
    wrap.className = 'flop-tile-wrap';

    const tile = document.createElement('div');
    tile.className = 'flop-tile';
    const claimedTeam = claims[id];
    if (claimedTeam && TEAMS[claimedTeam]) {
      tile.classList.add('claimed');
      tile.style.background = TEAMS[claimedTeam].color;
      tile.style.borderColor = TEAMS[claimedTeam].color;
    }
    const idEl = document.createElement('div');
    idEl.className = 'flop-id';
    idEl.textContent = WILDCARD_IDS.includes(id) ? 'Wildcard' : '#' + id;
    const nameEl = document.createElement('div');
    nameEl.className = 'flop-name';
    nameEl.textContent = getFlopCardLabel(id);
    tile.appendChild(idEl);
    tile.appendChild(nameEl);
    tile.onclick = () => claimNeighbourhood(id, getFlopCardLabel(id));
    wrap.appendChild(tile);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'flop-remove-btn';
    removeBtn.textContent = 'âœ•';
    removeBtn.onclick = (e) => { e.stopPropagation(); removeFromFlop(id); };
    wrap.appendChild(removeBtn);

    grid.appendChild(wrap);
  });

  addBtn.style.display = 'block';
  addBtn.disabled = flop.length >= FLOP_SIZE || remainingPool().length === 0;

  if (typeof layerById !== 'undefined') repaintAllClaims();
}

function revealPrivateCard(team) {
  const s = privateState[team] || { hand: [], revealed: 0, used: [], lastReveal: 0 };
  if (s.hand.length !== PRIVATE_CARD_COUNT) {
    showToast('Private hand is not ready yet');
    return;
  }
  if (s.revealed >= PRIVATE_CARD_COUNT) {
    showToast('All private cards revealed for ' + TEAMS[team].name);
    return;
  }
  const updated = {
    hand: s.hand,
    revealed: s.revealed + 1,
    used: s.used,
    lastReveal: s.lastReveal
  };
  privateState[team] = updated;
  savePersistedState();
  if (privateRef && firebaseReady) privateRef.child(team).set(updated);
  const revealedId = s.hand[s.revealed];
  renderPrivateCardsList();
  showToast(TEAMS[team].name + ' revealed ' + (nameById[revealedId] || '#' + revealedId));
}

function claimPrivateCard(team, cardId) {
  if (currentMode !== team) {
    showToast('Switch to ' + TEAMS[team].name + ' to claim this card.');
    return;
  }
  const s = privateState[team] || { hand: [], revealed: 0, used: [] };
  if (!s.hand.includes(cardId)) {
    showToast('This is not one of ' + TEAMS[team].name + "'s private cards.");
    return;
  }
  if (s.used.includes(cardId)) {
    showToast('This private card has already been claimed');
    return;
  }
  const cardIndex = s.hand.indexOf(cardId);
  if (cardIndex >= s.revealed) {
    showToast('Reveal this private card first');
    return;
  }
  if (claims[cardId]) {
    showToast(nameById[cardId] + ' is already claimed');
    return;
  }
  claims[cardId] = team;
  const updated = {
    hand: s.hand,
    revealed: s.revealed,
    used: [...s.used, cardId],
    lastReveal: s.lastReveal
  };
  privateState[team] = updated;
  savePersistedState();
  if (claimsRef && firebaseReady) claimsRef.child(cardId).set(team);
  if (privateRef && firebaseReady) privateRef.child(team).set(updated);
  repaintAllClaims();
  renderPrivateCardsList();
  showToast(nameById[cardId] + ' claimed by ' + TEAMS[team].name);
}

function renderPrivateCardsList() {
  const list = document.getElementById('private-cards-list');
  if (!list) return;
  list.innerHTML = '';

  const armedBanner = document.getElementById('armed-banner');
  armedBanner.classList.remove('show');

  Object.keys(TEAMS).forEach(team => {
    const canSee = myRole === team;

    const card = document.createElement('div');
    card.className = 'team-card' + (canSee ? '' : ' locked');
    card.style.background = canSee ? TEAMS[team].color : '';

    const head = document.createElement('div');
    head.className = 'team-card-head';
    const title = document.createElement('div');
    title.className = 'team-card-title';
    title.textContent = TEAMS[team].emoji + ' ' + TEAMS[team].name;
    head.appendChild(title);

    if (!canSee) {
      const lockMsg = document.createElement('div');
      lockMsg.className = 'locked-msg';
      lockMsg.innerHTML = 'ðŸ”’ Hidden';
      head.appendChild(lockMsg);
      card.appendChild(head);
      const note = document.createElement('div');
      note.style.fontSize = '11px';
      note.style.opacity = '0.8';
      note.textContent = "Only " + TEAMS[team].name + "'s own device can see this team's private cards.";
      card.appendChild(note);
      list.appendChild(card);
      return;
    }

    const s = privateState[team] || { hand: [], revealed: 0, used: [], lastReveal: 0 };
    const now = Date.now();
    const available = Math.max(s.revealed - s.used.length, 0);

    const dots = document.createElement('div');
    dots.className = 'team-dots';
    for (let i = 0; i < PRIVATE_CARD_COUNT; i++) {
      const d = document.createElement('span');
      d.className = 'team-dot' + (i < s.revealed ? ' on' : '');
      dots.appendChild(d);
    }
    head.appendChild(dots);

    const actions = document.createElement('div');
    actions.className = 'team-card-actions';

    const revealBtn = document.createElement('button');
    revealBtn.className = 'team-action-btn reveal-btn';
    revealBtn.disabled = s.revealed >= PRIVATE_CARD_COUNT;
    if (s.hand.length !== PRIVATE_CARD_COUNT) {
      revealBtn.textContent = 'Preparing cards';
    } else if (s.revealed >= PRIVATE_CARD_COUNT) {
      revealBtn.textContent = 'All revealed';
    } else {
      revealBtn.textContent = 'Reveal card';
    }
    revealBtn.onclick = () => revealPrivateCard(team);

    const revealNote = document.createElement('div');
    revealNote.style.fontSize = '11px';
    revealNote.style.opacity = '0.8';
    revealNote.textContent = available + ' revealed and usable';

    const cardsGrid = document.createElement('div');
    cardsGrid.className = 'private-card-grid';
    for (let i = 0; i < PRIVATE_CARD_COUNT; i++) {
      const tile = document.createElement('div');
      tile.className = 'flop-tile';
      if (i < s.revealed) {
        const cardId = s.hand[i];
        const isUsed = s.used.includes(cardId);
        tile.textContent = '#' + cardId + ' â€” ' + (nameById[cardId] || 'Unknown');
        tile.style.background = isUsed ? '#a9b2a9' : '#fdf6c9';
        tile.style.color = isUsed ? '#4a4a4a' : '#1f2d1f';
        if (!isUsed) {
          const claimButton = document.createElement('button');
          claimButton.className = 'add-card-btn';
          claimButton.style.marginTop = '8px';
          claimButton.textContent = 'Claim this card';
          claimButton.onclick = () => claimPrivateCard(team, cardId);
          tile.appendChild(claimButton);
        } else {
          const usedTag = document.createElement('div');
          usedTag.style.fontSize = '11px';
          usedTag.style.opacity = '0.7';
          usedTag.textContent = 'Already claimed';
          tile.appendChild(usedTag);
        }
      } else {
        tile.textContent = 'Hidden private card';
      }
      cardsGrid.appendChild(tile);
    }

    actions.appendChild(revealBtn);
    card.appendChild(head);
    card.appendChild(actions);
    card.appendChild(revealNote);
    card.appendChild(cardsGrid);
    list.appendChild(card);
  });
}

// Embedded geojson removed: ELIGIBLE_IDS and nameById will be set from external file.
// ELIGIBLE_IDS = geoData.features.map(f => f.properties.id);
// geoData.features.forEach(f => { nameById[f.properties.id] = f.properties.name; });

const map = L.map('map', {
  zoomControl: true,
  minZoom: 9,
  maxZoom: 19,
  attributionControl: false,
  tap: true
});

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  subdomains: 'abc',
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let geoLayer;
const labelMarkers = [];
const layerById = {};

function fillOpacityForZoom(zoom, claimedTeam) {
  if (claimedTeam) {
    if (zoom <= 11) return 0.65;
    if (zoom >= 16) return 0.35;
    return 0.65 - (zoom - 11) * (0.30 / 5);
  }
  if (zoom <= 11) return 0.75;
  if (zoom >= 16) return 0.08;
  return 0.75 - (zoom - 11) * (0.67 / 5);
}

function styleFor(id) {
  const team = claims[id];
  if (team && TEAMS[team]) {
    return {
      color: TEAMS[team].color,
      weight: 2,
      fillColor: TEAMS[team].color,
      fillOpacity: fillOpacityForZoom(map.getZoom(), team)
    };
  }
  return {
    color: '#3f7a3d',
    weight: 1,
    fillColor: '#e9e9e9',
    fillOpacity: 0.15
  };
}

function repaintAllClaims() {
  Object.keys(layerById).forEach(id => {
    layerById[id].setStyle(styleFor(id));
  });
}

function highlightFeature(e) {
  const layer = e.target;
  const id = layer.feature.properties.id;
  const team = claims[id];
  layer.setStyle({
    weight: 3,
    color: team && TEAMS[team] ? TEAMS[team].color : '#245623',
    fillOpacity: Math.min((styleFor(id).fillOpacity || 0.5) + 0.15, 0.95)
  });
  layer.bringToFront();
}

function resetFeature(e) {
  e.target.setStyle(styleFor(e.target.feature.properties.id));
}

function onEachFeature(feature, layer) {
  const props = feature.properties;
  layerById[props.id] = layer;
  function tooltipText() {
    const team = claims[props.id];
    let status;
    if (team && TEAMS[team]) status = ' â€” claimed by ' + TEAMS[team].name;
    else status = ' â€” available';
    return `#${props.id} â€” ${props.name}${status}`;
  }
  layer.bindTooltip(tooltipText, { className: 'hood-tooltip', sticky: true });
  layer.on({
    mouseover: highlightFeature,
    mouseout: resetFeature,
    click: (e) => {
      claimNeighbourhood(props.id, props.name);
    }
  });
}

// Load GeoJSON file and initialize geo-dependent UI once available.
fetch('toronto_140_neighbourhoods.geojson')
  .then(r => r.json())
  .then(data => {
    loadedGeoData = data;
    ELIGIBLE_IDS = loadedGeoData.features.map(f => f.properties.id);
    loadedGeoData.features.forEach(f => { nameById[f.properties.id] = f.properties.name; });

    geoLayer = L.geoJSON(loadedGeoData, { style: (f) => styleFor(f.properties.id), onEachFeature }).addTo(map);
    map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });

    // build label markers
    labelMarkers.length = 0;
    loadedGeoData.features.forEach(f => {
      const layer = L.geoJSON(f);
      const center = layer.getBounds().getCenter();
      const marker = L.marker(center, {
        icon: L.divIcon({
          className: 'hood-label',
          html: `<div style="font-size:10px;font-weight:700;color:#1f2d1f;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;text-align:center;white-space:nowrap;">${f.properties.id}</div>`,
          iconSize: [24, 14]
        }),
        interactive: false
      });
      labelMarkers.push(marker);
    });

    function updateLabels() {
      const zoom = map.getZoom();
      labelMarkers.forEach(m => {
        if (zoom >= 11 && zoom <= 15) {
          if (!map.hasLayer(m)) m.addTo(map);
        } else {
          if (map.hasLayer(m)) map.removeLayer(m);
        }
      });
    }

    map.on('zoomend', () => {
      updateLabels();
      repaintAllClaims();
    });
    updateLabels();

    const input = document.getElementById('search-input');
    const resultsBox = document.getElementById('search-results');
    const featureIndex = loadedGeoData.features.map(f => ({
      name: f.properties.name,
      id: f.properties.id,
      layer: L.geoJSON(f)
    }));

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      resultsBox.innerHTML = '';
      if (!q) return;
      const matches = featureIndex.filter(f =>
        f.name.toLowerCase().includes(q) || f.id === q
      ).slice(0, 8);
      matches.forEach(m => {
        const div = document.createElement('div');
        div.textContent = `#${m.id} â€” ${m.name}`;
        div.onclick = () => {
          map.fitBounds(m.layer.getBounds(), { maxZoom: 14 });
          resultsBox.innerHTML = '';
          input.value = m.name;
          input.blur();
        };
        resultsBox.appendChild(div);
      });
    });

    applyRoleUI();
    renderFlopGrid();
    renderPrivateCardsList();
    initFirebase();
  })
  .catch(err => {
    console.error('Failed to load GeoJSON', err);
    showToast('Failed to load neighbourhood data');
  });
