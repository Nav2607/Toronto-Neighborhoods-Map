// config.js (loaded before this file) declares `const firebaseConfig = {...}`,
// which becomes a global lexical binding this script can read directly.
const resolvedFirebaseConfig = firebaseConfig;

const TEAMS = {
  team1: { name: 'Team 1', color: '#e53935' },
  team2: { name: 'Team 2', color: '#1e88e5' },
  team3: { name: 'Team 3', color: '#43a047' }
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
// ---- Device role (persisted locally; NOT synced — this is what makes
//      private cards "private" to whichever device picked that team).
//      There is no Game Master role: every device can claim any team's
//      turf, manage the Flop, and reveal/remove/add Flop cards. ----
let myRole = localStorage.getItem('tnc_role') || null; // 'team1'|'team2'|'team3'
// Claiming is always done as your own team (myRole) — there's no
// "claiming as" switcher anymore. Clearing a claim, however, is still
// open to any device via the standalone Clear toggle below.
let clearMode = false;

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
  return !!resolvedFirebaseConfig &&
    typeof resolvedFirebaseConfig === 'object' &&
    resolvedFirebaseConfig.apiKey &&
    !String(resolvedFirebaseConfig.apiKey).startsWith('YOUR_') &&
    !String(resolvedFirebaseConfig.apiKey).startsWith('PASTE_');
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

function buildFreshPrivateState(seed = getGameSeed(), excludedIds = []) {
  const excludedSet = new Set(excludedIds);
  // Randomly choose 15 of the 64 neighbourhoods (5 per team) for the
  // private hands. Wildcards aren't in ALL_NEIGHBOURHOOD_IDS, so they can
  // never be selected here.
  const available = shuffleArray(
    ALL_NEIGHBOURHOOD_IDS.filter(id => !excludedSet.has(id)),
    seed
  ).slice(0, PRIVATE_RESERVE_COUNT);
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
    ...Object.keys(claims)
  ];
  const seed = getGameSeed() || createGameSeed();
  setGameSeed(seed);
  const nextState = {
    ...state,
    ...buildFreshPrivateState(seed, excludedIds)
  };

  if (privateRef) privateRef.set(nextState);
  return nextState;
}

// ---- The playable pool ----
// 64 neighbourhoods total, minus the 15 private-card reserve slots, plus 3 wildcards.
const ALL_NEIGHBOURHOOD_IDS = ['085','087','114','089','111','115','112','110','108','090','088','086','091','093','083','084','082','081','080','092','109','107','094','095','079','078','077','076','096','106','102','101','097','098','075','073','071','074','056','099','104','100','103','041','042','044','043','054','058','057','059','060','066','067','068','069','065','064','062','063','070','061','072','055'];
// Each game, the 64 neighbourhoods are randomly split (seeded, so every
// device agrees): 15 go into the three private hands (5 per team) and the
// remaining 49 — plus the 3 wildcards — form the pool the Flop is drawn
// from. Wildcards can never land in a private hand.
const PRIVATE_RESERVE_COUNT = 15;
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
    tag.textContent = TEAMS[myRole].name;
    tag.style.background = TEAMS[myRole].color;
  } else {
    tag.textContent = 'Set role';
    tag.style.background = '#1f2d1f';
  }

  const resetBtn = document.getElementById('reset-game-btn');
  if (resetBtn) {
    resetBtn.style.display = myRole === 'team1' ? 'inline-block' : 'none';
  }

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
    firebase.initializeApp(resolvedFirebaseConfig);
    claimsRef = firebase.database().ref('claims');
    flopRef = firebase.database().ref('flop');       // { revealed: bool, ids: [...] }
    privateRef = firebase.database().ref('privateCards');

    claimsRef.on('value', (snapshot) => {
      claims = snapshot.val() || {};
      firebaseReady = true;
      savePersistedState();
      setStatus('Live — synced', 'connected');
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
      if (typeof layerById !== 'undefined') repaintAllClaims();
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

function toggleClearMode() {
  clearMode = !clearMode;
  ['btn-clear-map', 'btn-clear-map-game'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', clearMode);
  });
  showToast(clearMode ? 'Clear mode on — tap a claimed spot to clear it' : 'Clear mode off');
}

// ---- Keep a neighbourhood's "private card" bookkeeping in sync with the
// map/flop claim state, no matter which path the claim came through
// (map tap, Flop tile tap, or the "Claim this card" button). This is
// also what makes stealing work correctly: if Team 2 claims a
// neighbourhood that happens to sit in Team 1's private hand (e.g. via a
// wildcard), Team 1's copy of that card needs to flip to "used" too, so
// Team 1 can no longer claim it — even though Team 1 never clicked
// anything themselves. ----
function ownerTeamOfCard(id) {
  return Object.keys(TEAMS).find(team => {
    const s = privateState[team];
    return s && Array.isArray(s.hand) && s.hand.includes(id);
  });
}

function markCardUsedForOwner(id) {
  const owner = ownerTeamOfCard(id);
  if (!owner) return;
  const s = privateState[owner] || { hand: [], revealed: 0, used: [], lastReveal: 0 };
  if (s.used.includes(id)) return;
  const updated = { hand: s.hand, revealed: s.revealed, used: [...s.used, id], lastReveal: s.lastReveal };
  privateState[owner] = updated;
  savePersistedState();
  if (privateRef && firebaseReady) privateRef.child(owner).set(updated);
  renderPrivateCardsList();
}

function unmarkCardUsedForOwner(id) {
  const owner = ownerTeamOfCard(id);
  if (!owner) return;
  const s = privateState[owner] || { hand: [], revealed: 0, used: [], lastReveal: 0 };
  if (!s.used.includes(id)) return;
  const updated = { hand: s.hand, revealed: s.revealed, used: s.used.filter(x => x !== id), lastReveal: s.lastReveal };
  privateState[owner] = updated;
  savePersistedState();
  if (privateRef && firebaseReady) privateRef.child(owner).set(updated);
  renderPrivateCardsList();
}

function claimNeighbourhood(id, name) {
  if (!myRole) { openRoleOverlay(); return; }

  if (clearMode) {
    if (!claims[id]) {
      showToast(name + ' is not claimed');
      return;
    }
    delete claims[id];
    savePersistedState();
    if (claimsRef && firebaseReady) claimsRef.child(id).remove();
    unmarkCardUsedForOwner(id);
    repaintAllClaims();
    renderFlopGrid();
    showToast(name + ' — cleared');
    return;
  }

  if (claims[id]) {
    showToast(name + ' is already claimed');
    return;
  }

  claims[id] = myRole;
  savePersistedState();
  if (claimsRef && firebaseReady) claimsRef.child(id).set(myRole);
  markCardUsedForOwner(id);
  repaintAllClaims();
  renderFlopGrid();
  showToast(name + ' → ' + TEAMS[myRole].name);
}

// ---- Flop logic (open to any device — no Game Master) ----
// The Flop is always drawn from the fixed 64-card FLOP_POOL_IDS deck.

function remainingPool() {
  const inFlopSet = new Set(flop);
  const reservedSet = new Set(getReservedPrivateIds());
  const regular = ALL_NEIGHBOURHOOD_IDS.filter(id => !inFlopSet.has(id) && !reservedSet.has(id) && !claims[id]);
  // Wildcards sit in the same 52-card pool as the 49 regular
  // neighbourhoods with no special weighting — they just need to not
  // already be in the Flop, and not already claimed (so a wildcard that
  // was claimed and then removed from the Flop isn't drawable again).
  const availableWildcards = WILDCARD_IDS.filter(id => !inFlopSet.has(id) && !claims[id]);
  return [...regular, ...availableWildcards];
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

// flopPoolIds: the neighbourhoods available for the Flop — i.e. the 49
// left over once the 15 private-hand cards have been dealt out.
function buildFreshFlop(seed = getGameSeed(), flopPoolIds = ALL_NEIGHBOURHOOD_IDS) {
  // Treat wildcards as just three more cards sitting in the same deck as
  // the 49 regular neighbourhoods (64 total minus the 15 dealt into
  // private hands) — a 52-card deck total — then shuffle the whole
  // combined pool and take the first 9 for a true uniform draw.
  // (Previously this rolled a separate wildcard *count* first and
  // force-inserted that many, which meant an average of 1.5 wildcards
  // landed in every single Flop instead of each wildcard having its
  // natural ~3-in-52 chance per slot.)
  const combinedPool = [...flopPoolIds, ...WILDCARD_IDS];
  return shuffleArray(combinedPool, seed + 1).slice(0, FLOP_SIZE);
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
  const freshPrivateState = buildFreshPrivateState(nextSeed);
  const privateIds = getReservedPrivateIds(freshPrivateState);
  const flopPoolIds = ALL_NEIGHBOURHOOD_IDS.filter(id => !privateIds.includes(id));
  const freshFlop = buildFreshFlop(nextSeed, flopPoolIds);

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
  showToast('Game reset — fresh flop and private cards');
}

function revealFlop() {
  const pool = remainingPool();
  if (pool.length < FLOP_SIZE) {
    showToast('Not enough cards available to reveal the Flop');
    return;
  }
  const nextSeed = getGameSeed() || createGameSeed();
  setGameSeed(nextSeed);
  const freshPrivateState = buildFreshPrivateState(nextSeed);
  const privateIds = getReservedPrivateIds(freshPrivateState);
  const flopPoolIds = ALL_NEIGHBOURHOOD_IDS.filter(id => !privateIds.includes(id));
  const freshFlop = buildFreshFlop(nextSeed, flopPoolIds);
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
  showToast('Added ' + getFlopCardLabel(next) + ' to the Flop');
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
    revealWrap.innerHTML = '<button class="reveal-flop-btn" onclick="revealFlop()">Reveal the Flop</button>';
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
    removeBtn.textContent = '✕';
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
  if (typeof layerById !== 'undefined') repaintAllClaims();
  showToast(TEAMS[team].name + ' revealed ' + (nameById[revealedId] || '#' + revealedId));
}

function claimPrivateCard(team, cardId) {
  if (myRole !== team) {
    showToast('Only ' + TEAMS[team].name + ' can claim this card.');
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
  savePersistedState();
  if (claimsRef && firebaseReady) claimsRef.child(cardId).set(team);
  markCardUsedForOwner(cardId);
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

  // Only this device's own team has anything to see here — other teams'
  // hands are never shown, even as a locked placeholder, since a device
  // only ever needs to act on its own hand.
  if (!myRole || !TEAMS[myRole]) {
    const prompt = document.createElement('div');
    prompt.className = 'team-card no-role';
    prompt.innerHTML = '<div class="team-card-title" style="margin-bottom:4px;">Set your team to see your private cards</div>' +
      '<div style="font-size:12px; opacity:0.75;">Each team\'s hand is only visible on that team\'s own device.</div>';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'pick-team-btn';
    pickBtn.textContent = 'Choose your team';
    pickBtn.onclick = () => openRoleOverlay();
    prompt.appendChild(pickBtn);
    list.appendChild(prompt);
    return;
  }

  [myRole].forEach(team => {
    const card = document.createElement('div');
    card.className = 'team-card';
    card.style.background = TEAMS[team].color;

    const head = document.createElement('div');
    head.className = 'team-card-head';
    const title = document.createElement('div');
    title.className = 'team-card-title';
    title.textContent = TEAMS[team].name;
    head.appendChild(title);

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
        const claimedByTeam = claims[cardId];
        // A card counts as "used" either because this team claimed it
        // themselves (s.used) or because another team claimed it out from
        // under them (e.g. via a wildcard) — either way it's no longer
        // claimable, so both cases must disable the button.
        const isUsed = s.used.includes(cardId) || !!claimedByTeam;
        tile.textContent = '#' + cardId + ' — ' + (nameById[cardId] || 'Unknown');
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
          usedTag.textContent = (claimedByTeam && claimedByTeam !== team && TEAMS[claimedByTeam])
            ? 'Claimed by ' + TEAMS[claimedByTeam].name + ' — no longer available'
            : 'Already claimed';
          tile.appendChild(usedTag);
        }
      } else {
        // Hidden card — was inheriting white text from the team-colored
        // card background (poor contrast on the pale tile). Style it
        // explicitly as a dim, dashed placeholder instead.
        tile.textContent = 'Hidden private card';
        tile.style.background = 'rgba(255,255,255,0.14)';
        tile.style.color = 'rgba(255,255,255,0.65)';
        tile.style.border = '2px dashed rgba(255,255,255,0.35)';
        tile.style.fontWeight = '600';
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
  zoomControl: false, // a single zoom control is added manually below
  minZoom: 9,
  maxZoom: 19,
  attributionControl: false,
  tap: true
});

// Bottom-right, out from under the search bar (which spans the top of
// the screen and would otherwise sit on top of a top-right zoom control).
L.control.zoom({ position: 'bottomright' }).addTo(map);

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
      dashArray: null,
      fillColor: TEAMS[team].color,
      fillOpacity: fillOpacityForZoom(map.getZoom(), team)
    };
  }

  // Not claimed yet — check for highlight-worthy states, in priority order:
  // 1. It's in MY OWN team's private hand (only visible to that team).
  // 2. It's currently in the revealed Flop (wildcards excluded, since
  //    they aren't real neighbourhoods on the map).
  const ownHandState = myRole ? privateState[myRole] : null;
  const isOwnPrivateCard = !!(ownHandState && Array.isArray(ownHandState.hand) &&
    ownHandState.hand.indexOf(id) !== -1 &&
    ownHandState.hand.indexOf(id) < ownHandState.revealed);
  const isInFlop = flopRevealed && flop.includes(id) && !WILDCARD_IDS.includes(id);

  // Note: these use plain solid fills (no SVG <pattern>/url() fill) —
  // patterns turned out to be unreliable to get filled AND clickable
  // across browsers. Private-card highlighting uses one fixed color
  // (purple) independent of team color — since only your own team ever
  // sees your own private-card highlight anyway, tying it to the team
  // color added confusion (it could look identical to an already-claimed
  // same-color neighbour) without adding any information.
  if (isOwnPrivateCard) {
    return {
      color: '#8e24aa',
      weight: 3,
      dashArray: null,
      fillColor: '#8e24aa',
      fillOpacity: 0.4
    };
  }
  if (isInFlop) {
    return {
      color: '#ff8c00',
      weight: 3,
      dashArray: null,
      fillColor: '#ff8c00',
      fillOpacity: 0.4
    };
  }

  return {
    color: '#3f7a3d',
    weight: 1,
    dashArray: null,
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
  const base = styleFor(id);
  layer.setStyle({
    weight: base.weight + 1,
    color: base.color,
    dashArray: base.dashArray || null,
    fillOpacity: Math.min((base.fillOpacity || 0.5) + 0.15, 0.95)
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
    if (team && TEAMS[team]) status = ' — claimed by ' + TEAMS[team].name;
    else status = ' — available';
    return `#${props.id} — ${props.name}${status}`;
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
// The City of Toronto neighbourhood GeoJSON doesn't always use "id"/"name"
// as the property keys (common alternatives: AREA_SHORT_CODE / AREA_S_CD /
// AREA_LONG_CODE for id, AREA_NAME / FIELD_7 for name). This helper finds
// whichever keys are actually present so the app doesn't render "undefined".
const ID_KEY_CANDIDATES = ['id', 'ID', 'Id', 'AREA_SHORT_CODE', 'AREA_S_CD', 'AREA_LONG_CODE', 'AREA_L_CD', 'FIELD_8', 'HOODNUM', 'HOOD_ID'];
const NAME_KEY_CANDIDATES = ['name', 'NAME', 'Name', 'AREA_NAME', 'AREA_DESC', 'FIELD_7', 'HOOD_NAME'];

function detectKey(sampleProps, candidates) {
  return candidates.find(k => sampleProps && sampleProps[k] !== undefined && sampleProps[k] !== null);
}

function normalizeFeatureProperties(data) {
  if (!data || !Array.isArray(data.features) || data.features.length === 0) return { idKey: null, nameKey: null };
  const sample = data.features[0].properties || {};
  console.log('GeoJSON sample properties (first feature):', sample);

  let idKey = detectKey(sample, ID_KEY_CANDIDATES);
  let nameKey = detectKey(sample, NAME_KEY_CANDIDATES);

  if (!idKey || !nameKey) {
    console.warn('Could not auto-detect id/name property keys from the GeoJSON. ' +
      'Available keys: ' + Object.keys(sample).join(', ') + '. ' +
      'Edit ID_KEY_CANDIDATES / NAME_KEY_CANDIDATES in app.js to add the correct key names.');
  }

  data.features.forEach(f => {
    if (!f.properties) f.properties = {};
    // Normalize onto properties.id / properties.name so the rest of the
    // app (which reads f.properties.id / f.properties.name) keeps working.
    f.properties.id = idKey ? String(f.properties[idKey]) : (f.properties.id !== undefined ? String(f.properties.id) : undefined);
    let rawName = nameKey ? f.properties[nameKey] : (f.properties.name || 'Unknown');
    // Strip a trailing " (123)" style numeric suffix, e.g. "Brookhaven-Amesbury (30)" -> "Brookhaven-Amesbury"
    if (typeof rawName === 'string') {
      rawName = rawName.replace(/\s*\(\d+\)\s*$/, '').trim();
    }
    f.properties.name = rawName;
  });

  return { idKey, nameKey };
}

fetch('toronto_140_neighbourhoods.geojson')
  .then(r => r.json())
  .then(data => {
    normalizeFeatureProperties(data);

    // Only the 64 neighbourhoods in ALL_NEIGHBOURHOOD_IDS are part of this
    // game (the rest of the 140 official boundaries are excluded entirely
    // from the map, search, labels, flop, and private hands).
    const playSet = new Set(ALL_NEIGHBOURHOOD_IDS);
    const filteredFeatures = data.features.filter(f => playSet.has(f.properties.id));

    const missingIds = ALL_NEIGHBOURHOOD_IDS.filter(id => !filteredFeatures.some(f => f.properties.id === id));
    if (missingIds.length) {
      console.warn('These ids from ALL_NEIGHBOURHOOD_IDS were not found in the GeoJSON:', missingIds);
    }

    loadedGeoData = { ...data, features: filteredFeatures };
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
    const clearBtn = document.getElementById('search-clear');
    const featureIndex = loadedGeoData.features.map(f => ({
      name: f.properties.name,
      id: f.properties.id,
      layer: L.geoJSON(f)
    }));

    function closeResults() {
      resultsBox.innerHTML = '';
      resultsBox.classList.remove('show');
    }

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      clearBtn.classList.toggle('show', input.value.length > 0);
      resultsBox.innerHTML = '';
      if (!q) { resultsBox.classList.remove('show'); return; }
      const matches = featureIndex.filter(f =>
        f.name.toLowerCase().includes(q) || f.id === q
      ).slice(0, 8);
      matches.forEach(m => {
        const div = document.createElement('div');
        const codeSpan = document.createElement('span');
        codeSpan.className = 'res-code';
        codeSpan.textContent = '#' + m.id;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = m.name;
        div.appendChild(codeSpan);
        div.appendChild(nameSpan);
        div.onclick = () => {
          map.fitBounds(m.layer.getBounds(), { maxZoom: 14 });
          closeResults();
          input.value = m.name;
          clearBtn.classList.add('show');
          input.blur();
        };
        resultsBox.appendChild(div);
      });
      resultsBox.classList.toggle('show', matches.length > 0);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      closeResults();
      clearBtn.classList.remove('show');
      input.focus();
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