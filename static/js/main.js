/**
 * main.js — CivicTrack frontend
 * - polished theme toggle (light/dark)
 * - search above map (nominatim)
 * - map click select + reverse geocode
 * - robust Refresh with retry behavior
 * - socket.io realtime
 */

document.addEventListener('DOMContentLoaded', () => {
  /* ---------- CONSTANTS ---------- */
  const CATEGORY_COLORS = {
    roads: '#ff7a29',    // 🟠 Orange
    water: '#36b3f6',    // 🔵 Blue
    garbage: '#9aa0a6',  // ⚪ Gray
    lighting: '#ffd34d', // 🟡 Yellow
    safety: '#ff5c5c',   // 🔴 Red
    obstructions: '#9b59b6' // 🟣 Purple
  };

  const DEFAULT = { lat: 12.9716, lng: 77.5946, zoom: 13 };
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search?format=json&q=';
  const DEBOUNCE_DELAY = 300;
  
  const TOUR = [
    { 
      title: 'Welcome', 
      text: 'PublicTrack helps you report local problems and see what others reported nearby.' 
    },
    { 
      title: 'Map & Colors', 
      text: `
        <div style="margin-bottom: 8px;">Dots = reported issues. Colors indicate the category:</div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
          <div><span style="color: #ff7a29">🟠</span> <b>Roads</b>: Potholes, traffic</div>
          <div><span style="color: #36b3f6">🔵</span> <b>Water</b>: Supply, flooding</div>
          <div><span style="color: #9aa0a6">⚪</span> <b>Garbage</b>: Waste, littering</div>
          <div><span style="color: #ffd34d">🟡</span> <b>Lighting</b>: Streetlights</div>
          <div><span style="color: #ff5c5c">🔴</span> <b>Safety</b>: Hazards, crime</div>
          <div><span style="color: #9b59b6">🟣</span> <b>Obstructions</b>: Blocked paths</div>
        </div>
        <div style="margin-top: 12px;">Click any dot to see details.</div>
      `
    },
    { title: 'Search & Select', text: 'Search your address or click the map. We tolerate typos & special symbols.' },
    { title: 'Filters', text: 'Use Status/Category and the radius slider to focus results.' },
    { title: 'Report', text: 'Fill Title + Description + Category and press Submit. Use location button if unsure.' },
    { title: 'Done', text: 'You are ready — explore or report. You can close the tour anytime.' }
  ];

  /* ---------- ELEMENTS ---------- */
  const loadingOverlay = document.getElementById('loading-overlay');
  const messageEl = document.getElementById('message');
  const addrInput = document.getElementById('addressInput');
  const addrClear = document.getElementById('address-clear');
  const addrSuggestions = document.getElementById('addr-suggestions');
  const addressHidden = document.getElementById('addressHidden');
  const radiusFilter = document.getElementById('radiusFilter');
  const radiusValue = document.getElementById('radiusValue');
  const applyFilters = document.getElementById('applyFilters');
  const refreshBtn = document.getElementById('refresh-data');
  const issueForm = document.getElementById('issueForm');
  const titleInput = document.getElementById('title');
  const descInput = document.getElementById('description');
  const charCounter = document.getElementById('charCounter');
  const categoryInput = document.getElementById('category');
  const clearForm = document.getElementById('clearForm');
  const startTour = document.getElementById('start-tour');
  const tourOverlay = document.getElementById('tour-overlay');
  const tourContent = document.getElementById('tour-content');
  const tourPrev = document.getElementById('tour-prev');
  const tourNext = document.getElementById('tour-next');
  const tourSkip = document.getElementById('tour-skip');
  const tourStep = document.getElementById('tour-step');
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = document.getElementById('theme-icon');
  const locateMeBtn = document.getElementById('locate-me');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');
  const statusFilter = document.getElementById('statusFilter');
  const categoryFilter = document.getElementById('categoryFilter');

  /* ---------- HELPER FUNCTIONS ---------- */
  function setLoading(show = true) {
    loadingOverlay.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function showMessage(text, options = {}) {
    messageEl.hidden = false;
    messageEl.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    messageEl.appendChild(span);

    if (options.retry && typeof options.retry === 'function') {
      const btn = document.createElement('button');
      btn.textContent = 'Retry';
      btn.className = 'btn-ghost';
      btn.style.marginLeft = '12px';
      btn.onclick = () => { options.retry(); };
      messageEl.appendChild(btn);
    }

    if (options.timeout) {
      setTimeout(() => { messageEl.hidden = true; }, options.timeout);
    }
  }

  function hideMessage() { messageEl.hidden = true; }

  function getMarkerIcon(category) {
    const color = CATEGORY_COLORS[category] || '#2ecc71';
    return L.divIcon({ 
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};box-shadow:0 0 0 4px rgba(0,0,0,0.06)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function escapeHtml(s = '') { 
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); 
  }

  /* ---------- MAP INITIALIZATION ---------- */
  const map = L.map('map', { preferCanvas: true }).setView([DEFAULT.lat, DEFAULT.lng], DEFAULT.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
    attribution: '© OpenStreetMap' 
  }).addTo(map);

  const issuesLayer = L.layerGroup().addTo(map);
  let currentSelected = null;

  function clearMarkers() { 
    issuesLayer.clearLayers(); 
    currentSelected = null; 
  }

  function addIssueMarker(issue, open = false) {
    const lat = parseFloat(issue.latitude ?? issue.lat ?? issue.location?.lat);
    const lng = parseFloat(issue.longitude ?? issue.lng ?? issue.location?.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    
    const m = L.marker([lat, lng], { icon: getMarkerIcon(issue.category) });
    const title = issue.title ?? 'Issue';
    const html = `
      <strong>${escapeHtml(title)}</strong>
      <div class="muted" style="margin-top:6px">
        ${escapeHtml(issue.category ?? '')} • ${escapeHtml(issue.status ?? '')}
      </div>
      <p style="margin-top:8px">${escapeHtml(issue.description ?? '')}</p>
    `;
    m.bindPopup(html);
    m.addTo(issuesLayer);
    if (open) m.openPopup();
  }

  /* ---------- SEARCH FUNCTIONS ---------- */
  let debounceTimer;
  async function fetchSuggestions(query) {
    if (!query.trim()) {
      addrSuggestions.hidden = true;
      return;
    }
    
    try {
      const response = await fetch(`${NOMINATIM_URL}${encodeURIComponent(query)}`);
      const results = await response.json();
      
      addrSuggestions.innerHTML = '';
      results.slice(0, 5).forEach(result => {
        const li = document.createElement('li');
        li.textContent = result.display_name;
        li.onclick = () => selectSuggestion(result);
        addrSuggestions.appendChild(li);
      });
      
      addrSuggestions.hidden = results.length === 0;
    } catch (e) {
      console.error('Search failed:', e);
      addrSuggestions.hidden = true;
    }
  }

  function selectSuggestion(result) {
    addrInput.value = result.display_name;
    addrSuggestions.hidden = true;
    map.setView([result.lat, result.lon], 16);
    addressHidden.value = result.display_name;
  }

  /* ---------- DATA FETCHING ---------- */
  async function fetchIssues() {
    setLoading(true);
    try {
      const center = map.getCenter();
      const radius = radiusFilter.value;
      const status = statusFilter.value;
      const category = categoryFilter.value;
      
      const params = new URLSearchParams({
        lat: center.lat,
        lng: center.lng,
        radius: radius,
        ...(status && { status }),
        ...(category && { category })
      });
      
      const response = await fetch(`/api/issues?${params}`);
      const issues = await response.json();
      
      clearMarkers();
      issues.forEach(issue => addIssueMarker(issue));
      showMessage(`Loaded ${issues.length} issues`, { timeout: 2000 });
    } catch (e) {
      showMessage('Failed to load issues', { retry: fetchIssues });
      console.error('Fetch issues failed:', e);
    } finally {
      setLoading(false);
    }
  }

  /* ---------- FORM HANDLING ---------- */
  async function submitIssueForm(e) {
    e.preventDefault();
    
    if (!titleInput.value || !descInput.value || !categoryInput.value) {
      showMessage('Please fill all required fields');
      return;
    }
    
    const center = map.getCenter();
    
    try {
      setLoading(true);
      const response = await fetch('/api/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleInput.value,
          description: descInput.value,
          category: categoryInput.value,
          latitude: center.lat,
          longitude: center.lng,
          address: addressHidden.value
        })
      });
      
      if (response.ok) {
        const newIssue = await response.json();
        addIssueMarker(newIssue, true);
        issueForm.reset();
        charCounter.textContent = '0 / 300';
        showMessage('Issue submitted successfully!', { timeout: 3000 });
      } else {
        throw new Error('Submission failed');
      }
    } catch (e) {
      showMessage('Failed to submit issue', { retry: () => issueForm.requestSubmit() });
      console.error('Submit failed:', e);
    } finally {
      setLoading(false);
    }
  }

  /* ---------- TOUR FUNCTIONS ---------- */
  let tIdx = 0;
  function openTour(i = 0) { 
    tIdx = i; 
    renderTour(); 
    tourOverlay.setAttribute('aria-hidden', 'false'); 
    tourOverlay.style.display = 'flex'; 
    document.body.style.overflow = 'hidden'; 
  }

  function closeTour() { 
    tourOverlay.setAttribute('aria-hidden', 'true'); 
    tourOverlay.style.display = 'none'; 
    document.body.style.overflow = ''; 
  }

  function renderTour() { 
    const s = TOUR[tIdx]; 
    tourContent.innerHTML = `<h4>${s.title}</h4><p>${s.text}</p>`; 
    tourStep.textContent = `${tIdx+1}/${TOUR.length}`; 
    tourPrev.disabled = tIdx === 0; 
    tourNext.textContent = (tIdx === TOUR.length-1 ? 'Finish' : 'Next'); 
  }

  /* ---------- SOCKET.IO ---------- */
  try {
    const socket = io();
    socket.on('connect', () => console.log('socket connected', socket.id));
    socket.on('new_issue', (issue) => { 
      addIssueMarker(issue, true); 
      showMessage('New issue posted — map updated', { timeout: 2400 }); 
    });
  } catch (e) { console.warn('socket not connected', e); }

  /* ---------- EVENT LISTENERS ---------- */
  // Theme toggle
  themeToggle?.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    themeIcon.className = newTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    localStorage.setItem('theme', newTheme);
  });

  // Search functionality
  addrInput?.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggestions(e.target.value), DEBOUNCE_DELAY);
  });

  addrClear?.addEventListener('click', () => {
    addrInput.value = '';
    addrSuggestions.hidden = true;
  });

  document.addEventListener('click', (e) => {
    if (!addrSuggestions.contains(e.target) && e.target !== addrInput) {
      addrSuggestions.hidden = true;
    }
  });

  // Map controls
  locateMeBtn?.addEventListener('click', () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.setView([pos.coords.latitude, pos.coords.longitude], 16);
          showMessage('Location found', { timeout: 2000 });
        },
        (err) => showMessage('Location access denied or failed')
      );
    } else {
      showMessage('Geolocation not supported by your browser');
    }
  });

  zoomInBtn?.addEventListener('click', () => map.zoomIn());
  zoomOutBtn?.addEventListener('click', () => map.zoomOut());

  // Form handling
  issueForm?.addEventListener('submit', submitIssueForm);

  descInput?.addEventListener('input', () => {
    charCounter.textContent = `${descInput.value.length} / 300`;
  });

  clearForm?.addEventListener('click', () => {
    issueForm.reset();
    charCounter.textContent = '0 / 300';
  });

  // Filters
  radiusFilter?.addEventListener('input', () => {
    radiusValue.textContent = `${radiusFilter.value} km`;
  });

  applyFilters?.addEventListener('click', fetchIssues);

  // Refresh button
  refreshBtn?.addEventListener('click', fetchIssues);

  // Tour controls
  startTour?.addEventListener('click', () => openTour(0));
  tourNext?.addEventListener('click', () => { 
    if (tIdx < TOUR.length-1) { tIdx++; renderTour(); } 
    else closeTour(); 
  });
  tourPrev?.addEventListener('click', () => { 
    if (tIdx > 0) { tIdx--; renderTour(); } 
  });
  tourSkip?.addEventListener('click', closeTour);

  // Map click handler
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    // You can add code here to handle map clicks if needed
  });

  /* ---------- INITIALIZATION ---------- */
  // Set initial theme
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeIcon.className = savedTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';

  // Initialize map and load data
  map.whenReady(() => { 
    setTimeout(() => { 
      setLoading(false); 
      fetchIssues(); 
    }, 600); 
  });
});