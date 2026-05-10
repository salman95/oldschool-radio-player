/* ============================================================
   RadioApp &mdash; Frontend Application
   ============================================================ */

(function () {
  'use strict';

  // ===================== State =====================
  const state = {
    user: null,
    currentStation: null,
    currentTracks: [],
    isTunedIn: false,
    tunedStationId: null,      // the station id the audio element is actually connected to
    volume: 75,
    animationId: null,
    stations: [],
    audioElement: null,
    audioContext: null,
    analyser: null,
    statusPollTimer: null,
    metadataTimer: null,
  };

  // ===================== DOM Helpers =====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ===================== API Helper =====================
  async function api(path, options = {}) {
    const defaults = {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    };
    const res = await fetch('/api' + path, { ...defaults, ...options });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401) {
        logout();
        return { ok: false, status: 401, error: 'Session expired' };
      }
      return { ok: false, status: res.status, error: body.error || 'Request failed' };
    }
    return { ok: true, ...body };
  }

  // ===================== Login =====================
  const loginForm = $('#login-form');
  const loginScreen = $('#login-screen');
  const appScreen = $('#app-screen');

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    const loginBtn = $('#login-btn');
    const errorMsg = $('#login-error');

    if (!username || !password) {
      errorMsg.textContent = 'Please enter both fields.';
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';
    errorMsg.textContent = '';

    const result = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    loginBtn.disabled = false;
    loginBtn.textContent = 'OK';

    if (!result.ok) {
      errorMsg.textContent = result.error || 'Login failed. Check your credentials.';
      $('#password').value = '';
      $('#password').focus();
      return;
    }

    state.user = result.user;
    enterApp();
  });

  async function checkSession() {
    const result = await api('/session');
    if (result.ok && result.user) {
      state.user = result.user;
      enterApp();
    }
  }

  function enterApp() {
    loginScreen.classList.remove('active');
    appScreen.classList.add('active');
    applyUserMode();
    loadStations();
    setStatus('Welcome, ' + state.user.username);
  }

  function applyUserMode() {
    if (!state.user) return;
    if (state.user.role === 'admin') {
      document.body.classList.add('admin-mode');
    } else {
      document.body.classList.remove('admin-mode');
    }
    $('#display-username').textContent = state.user.username;
    const roleEl = $('#display-role');
    roleEl.textContent = state.user.role === 'admin' ? 'Administrator' : 'Listener';
    roleEl.className = 'role-tag ' + (state.user.role === 'admin' ? 'admin-tag' : 'listener-tag');
  }

  // ===================== Logout =====================
  async function logout() {
    disconnectFromStation();
    await api('/logout', { method: 'POST' });
    state.user = null;
    state.currentStation = null;
    state.currentTracks = [];
    document.body.classList.remove('admin-mode');
    appScreen.classList.remove('active');
    loginScreen.classList.add('active');
    loginForm.reset();
    $('#username').focus();
    showView('stations');
  }

  $('#menu-logout').addEventListener('click', logout);

  // ===================== View Navigation =====================
  function showView(name) {
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    var target = $('#view-' + name);
    if (target) target.classList.add('active');

    if (name === 'users' && state.user && state.user.role === 'admin') loadUsers();
    if (name === 'ai-news' && state.user && state.user.role === 'admin') loadAiNews();
    if (name === 'logs' && state.user && state.user.role === 'admin') loadLogs();
  }

  $$('.menu-item[data-menu]').forEach(function (item) {
    item.addEventListener('click', function () {
      var menu = item.dataset.menu;
      if (menu === 'help') {
        showView('help');
        return;
      }
      showView(menu);
    });
  });

  // ===================== Stations =====================
  async function loadStations() {
    var result = await api('/stations');
    if (!result.ok) {
      setStatus('Failed to load stations');
      return;
    }
    state.stations = result.stations;
    renderStations();
  }

  function renderStations() {
    var list = $('#station-list');
    list.innerHTML = '';

    if (state.stations.length === 0) {
      list.innerHTML = '<tr><td colspan="5" class="loading-row">No stations yet. Add one to get started!</td></tr>';
      $('#status-stations').textContent = '0 stations';
      return;
    }

    state.stations.forEach(function (station) {
      var tr = document.createElement('tr');
      tr.dataset.station = station.id;
      var isSelected = state.currentStation && state.currentStation.id === station.id;
      if (isSelected) tr.classList.add('selected');

      var statusHtml;
      if (station.is_playing) {
        statusHtml = '<span class="status-dot broadcasting" title="Broadcasting"></span>' +
          '<span class="broadcasting-label">LIVE</span>';
      } else {
        statusHtml = '<span class="status-dot" title="Offline"></span>';
      }

      var actionsHtml = '';
      if (state.user && state.user.role === 'admin') {
        // Admin: Play/Stop buttons
        if (station.is_playing) {
          actionsHtml = '<button class="btn btn-sm btn-danger" data-action="stop" data-station="' + station.id + '">&#9632; Stop</button>';
        } else {
          actionsHtml = '<button class="btn btn-sm" data-action="play" data-station="' + station.id + '" ' +
            (station.track_count === 0 ? 'disabled title="No tracks"' : '') + '>&#9654; Play</button>';
        }
        actionsHtml += ' <button class="btn btn-sm btn-danger" data-action="delete" data-station="' + station.id + '">&#10006;</button>';
      } else {
        // Listener: Tune In/Disconnect
        // Remote streams are always available; local streams need is_playing
        if (station.stream_url || station.is_playing) {
          if (state.isTunedIn && state.currentStation && state.currentStation.id === station.id) {
            actionsHtml = '<button class="btn btn-sm btn-danger" data-action="disconnect" data-station="' + station.id + '">&#9632; Disconnect</button>';
          } else {
            actionsHtml = '<button class="btn btn-sm" data-action="tunein" data-station="' + station.id + '">&#9654; Tune In</button>';
          }
        } else {
          actionsHtml = '<span style="color:#888;font-size:0.75rem;">Offline</span>';
        }
      }

      tr.innerHTML =
        '<td class="col-status">' + statusHtml + '</td>' +
        '<td class="col-name">' +
          (station.stream_url ? '<span class="stream-badge">&#127760;</span> ' : '<span class="stream-badge local">&#128193;</span> ') +
          esc(station.name) + '</td>' +
        '<td class="col-tracks">' + station.track_count + ' tracks</td>' +
        '<td class="col-listeners">' + (station.is_playing ? station.listener_count : '\u2014') + '</td>' +
        '<td class="col-actions">' + actionsHtml + '</td>';
      list.appendChild(tr);
    });

    $('#status-stations').textContent = state.stations.length + ' station' + (state.stations.length !== 1 ? 's' : '');
  }

  // Station table click delegation
  $('#station-table').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
      var action = btn.dataset.action;
      var stationId = parseInt(btn.dataset.station, 10);
      if (action === 'play') adminPlayStation(stationId);
      else if (action === 'stop') adminStopStation(stationId);
      else if (action === 'delete') confirmDeleteStation(stationId);
      else if (action === 'tunein') tuneIntoStation(stationId);
      else if (action === 'disconnect') disconnectFromStation();
      return;
    }

    var tr = e.target.closest('tr');
    if (tr && tr.dataset.station) {
      selectStation(parseInt(tr.dataset.station, 10));
    }
  });

  async function selectStation(stationId) {
    var station = state.stations.find(function (s) { return s.id === stationId; });
    if (!station) return;

    // Highlight
    $('#station-list').querySelectorAll('tr.selected').forEach(function (r) { r.classList.remove('selected'); });
    var row = $('#station-list').querySelector('tr[data-station="' + stationId + '"]');
    if (row) row.classList.add('selected');

    state.currentStation = station;
    $('#playing-station-name').textContent = station.name;
    setStatus('Selected: ' + station.name);
  }

  // ===================== Admin: Play/Stop Station =====================
  async function adminPlayStation(stationId) {
    var result = await api('/stations/' + stationId + '/play', { method: 'POST' });
    if (!result.ok) {
      setStatus('Error: ' + result.error);
      return;
    }
    setStatus('Station is now broadcasting');
    await loadStations();
  }

  async function adminStopStation(stationId) {
    var result = await api('/stations/' + stationId + '/stop', { method: 'POST' });
    if (!result.ok) {
      setStatus('Error: ' + result.error);
      return;
    }
    // If we were tuned into this station, disconnect
    if (state.isTunedIn && state.currentStation && state.currentStation.id === stationId) {
      disconnectFromStation();
    }
    setStatus('Station stopped');
    await loadStations();
  }

  async function confirmDeleteStation(stationId) {
    var station = state.stations.find(function (s) { return s.id === stationId; });
    if (!station) return;
    showConfirm('Delete station "' + station.name + '"?', async function () {
      var result = await api('/stations/' + stationId, { method: 'DELETE' });
      if (!result.ok) {
        setStatus('Error: ' + result.error);
        return;
      }
      if (state.currentStation && state.currentStation.id === stationId) {
        disconnectFromStation();
        state.currentStation = null;
        state.currentTracks = [];
        $('#playing-station-name').textContent = 'No station tuned in';
        $('#track-artist-title').textContent = '';
        $('#track-queue-section').style.display = 'none';
      }
      await loadStations();
      setStatus('Station "' + station.name + '" deleted');
    });
  }

  // ===================== Listener: Tune In / Disconnect =====================
  async function tuneIntoStation(stationId) {
    var station = state.stations.find(function (s) { return s.id === stationId; });
    if (!station) return;
    // Remote streams don't need Play/Stop — stream directly from URL
    if (!station.stream_url && !station.is_playing) {
      setStatus('Station is not broadcasting');
      return;
    }

    // Disconnect from any previous station
    disconnectFromStation();

    // Select the station
    await selectStation(stationId);

    // Create audio element and connect to stream
    state.audioElement = new Audio();
    state.audioElement.crossOrigin = 'anonymous';
    state.audioElement.volume = state.volume / 100;
    state.audioElement.preload = 'auto';

    // Web Audio API setup is deferred to after play() resolves
    // (like spare.html does — prevents playback issues)

    // Store which station this audio element is connected to
    state.tunedStationId = stationId;

    state.audioElement.addEventListener('error', function () {
      if (state.tunedStationId !== stationId) return; // stale event
      console.error('Audio error for station', stationId);
      setStatus('Playback error. Station may have stopped.');
      state.isTunedIn = false;
      stopVisualizer();
      updatePlayerDisplay();
    });

    state.audioElement.addEventListener('waiting', function () {
      if (state.tunedStationId !== stationId) return;
      setStatus('Buffering...');
    });

    state.audioElement.addEventListener('playing', function () {
      if (state.tunedStationId !== stationId) return;
      setStatus('Tuned in: ' + station.name);
    });

    state.audioElement.addEventListener('stalled', function () {
      if (state.tunedStationId !== stationId) return; // stale event from previous station
      setStatus('Stream stalled — waiting for data...');
    });

    state.audioElement.addEventListener('ended', function () {
      if (state.tunedStationId !== stationId) return; // stale event
      console.log('Audio stream ended for station', stationId);
      // Don't set isTunedIn=false here; the stream may reconnect.
      // Status polling will detect if the station truly stopped.
      setStatus('Stream ended — station may have stopped.');
      state.isTunedIn = false;
      stopVisualizer();
      updatePlayerDisplay();
    });

    state.audioElement.addEventListener('suspend', function () {
      console.log('Audio stream suspended');
    });

    // Set tuned-in state immediately so UI shows connected, visualizer starts
    state.isTunedIn = true;
    startVisualizer();
    $('#playing-status-indicator').className = 'status-indicator tunedin';
    updatePlayerDisplay();
    startStatusPoll(stationId);

    // Remote URL streams connect directly + fetch live song metadata
    if (station.stream_url) {
      state.audioElement.src = station.stream_url;
      state.audioElement.crossOrigin = 'anonymous';
      startMetadataPoll(station.stream_url);
    } else {
      state.audioElement.src = '/stream?station_id=' + stationId;
    }
    state.audioElement.play().then(function () {
      // Set up Web Audio API after play starts (like spare.html)
      try {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        state.analyser = state.audioContext.createAnalyser();
        state.analyser.fftSize = 256;
        var source = state.audioContext.createMediaElementSource(state.audioElement);
        source.connect(state.analyser);
        state.analyser.connect(state.audioContext.destination);
      } catch (e) {
        console.warn('Web Audio not available, using fake visualizer');
        state.audioContext = null;
        state.analyser = null;
      }
    }).catch(function (err) {
      console.error('Play failed:', err);
      setStatus('Could not connect to stream');
    });
  }

  function disconnectFromStation() {
    if (state.audioElement) {
      state.audioElement.pause();
      state.audioElement.src = '';
      state.audioElement = null;
    }
    if (state.audioContext) {
      state.audioContext.close();
      state.audioContext = null;
      state.analyser = null;
    }
    if (state.statusPollTimer) {
      clearInterval(state.statusPollTimer);
      state.statusPollTimer = null;
    }
    stopMetadataPoll();
    state.isTunedIn = false;
    state.tunedStationId = null;
    stopVisualizer();
    $('#playing-status-indicator').className = 'status-indicator';
    $('#track-artist-title').textContent = 'Disconnected';
    updatePlayerDisplay();
    setStatus('Disconnected');
  }

  function updatePlayerDisplay() {
    var tuneInBtn = $('#btn-tunein');
    var disconnectBtn = $('#btn-disconnect');

    if (state.isTunedIn) {
      tuneInBtn.disabled = true;
      disconnectBtn.disabled = false;
    } else {
      tuneInBtn.disabled = false;
      disconnectBtn.disabled = true;
    }

    // Re-render station list to update Tune In/Disconnect buttons
    renderStations();
  }

  // ===================== Metadata Fetching for Remote Streams =====================
  // Fetches Icecast/SHOUTcast metadata showing current song title.

  async function fetchStationMetadata(stationUrl) {
    try {
      var base = new URL(stationUrl).origin;
      var resp = await fetch(base + '/status-json.xsl', { mode: 'cors' });
      if (!resp.ok) return null;
      var data = await resp.json();
      if (data && data.icestats && data.icestats.source) {
        var source = Array.isArray(data.icestats.source) ? data.icestats.source[0] : data.icestats.source;
        if (source && source.title) {
          return source.title;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function startMetadataPoll(stationUrl) {
    if (state.metadataTimer) clearInterval(state.metadataTimer);
    state.metadataTimer = setInterval(async function () {
      var track = await fetchStationMetadata(stationUrl);
      if (track) {
        $('#track-artist-title').textContent = track;
      }
    }, 15000);
    // Initial fetch immediately
    fetchStationMetadata(stationUrl).then(function (track) {
      if (track) $('#track-artist-title').textContent = track;
    });
  }

  function stopMetadataPoll() {
    if (state.metadataTimer) {
      clearInterval(state.metadataTimer);
      state.metadataTimer = null;
    }
  }

  // ===================== Status Polling =====================
  function startStatusPoll(stationId) {
    if (state.statusPollTimer) clearInterval(state.statusPollTimer);
    state.statusPollTimer = setInterval(function () {
      // If no longer tuned in, stop polling
      if (!state.isTunedIn || state.tunedStationId !== stationId) {
        clearInterval(state.statusPollTimer);
        state.statusPollTimer = null;
        return;
      }
      api('/stations/' + stationId + '/status').then(function (result) {
        if (!result.ok) return;
        if (result.currentTrack) {
          $('#track-artist-title').textContent = result.currentTrack;
        }
        if (!result.is_playing) {
          // Station was stopped by admin
          disconnectFromStation();
          setStatus('Station stopped by administrator');
        }
      }).catch(function () {
        // Ignore poll errors
      });
    }, 3000);
  }

  // ===================== Add Station =====================
  var addStationDialog = $('#add-station-dialog');
  $('#btn-add-station').addEventListener('click', function () {
    addStationDialog.classList.add('active');
    $('#station-name').focus();
  });

  $('#add-station-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('#station-name').value.trim();
    var dir = $('#station-dir').value.trim();
    var url = $('#station-url').value.trim();
    var errorMsg = $('#add-station-error');
    var infoMsg = $('#add-station-info');
    var submitBtn = $('#add-station-submit');
    if (!name || (!dir && !url)) { setStatus('Enter a directory or stream URL'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';
    errorMsg.textContent = '';
    infoMsg.textContent = '';

    var result = await api('/stations', {
      method: 'POST',
      body: JSON.stringify({ name: name, stream_dir: dir, stream_url: url }),
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'OK';

    if (!result.ok) {
      errorMsg.textContent = result.error || 'Failed to add station';
      return;
    }

    if (result.stream_url) {
      infoMsg.textContent = 'Remote station added! Click Play to start.';
    } else {
      infoMsg.textContent = 'Created! ' + result.tracks_found + ' tracks found.';
      if (result.scan_errors && result.scan_errors.length > 0) {
        infoMsg.textContent += ' (' + result.scan_errors.length + ' warnings)';
      }
    }

    addStationDialog.classList.remove('active');
    this.reset();
    errorMsg.textContent = '';
    await loadStations();
    setStatus('Station "' + name + '" added');
  });

  // ===================== Tracks =====================
  async function loadTracks(stationId) {
    var result = await api('/stations/' + stationId + '/tracks');
    if (!result.ok) {
      setStatus('Failed to load tracks: ' + result.error);
      return;
    }

    state.currentTracks = result.tracks;
    renderTracks(result.tracks, result.station_name);
  }

  function renderTracks(tracks, stationName) {
    var section = $('#track-queue-section');
    var list = $('#track-list');
    var queueTitle = $('#queue-title');
    var queueCount = $('#queue-count');

    section.style.display = 'block';
    queueTitle.textContent = stationName + ' \u2014 Track Queue';
    queueCount.textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');

    list.innerHTML = '';

    if (tracks.length === 0) {
      list.innerHTML = '<tr><td colspan="3" class="loading-row">No audio files found in this directory.</td></tr>';
      return;
    }

    tracks.forEach(function (track, index) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-num">' + (index + 1) + '</td>' +
        '<td class="col-name">' + esc(track.display_name) + '</td>' +
        '<td class="col-size">' + formatSize(track.file_size) + '</td>';
      list.appendChild(tr);
    });
  }

  // ===================== Rescan Station =====================
  $('#btn-rescan').addEventListener('click', async function () {
    if (!state.currentStation) return;
    var stationId = state.currentStation.id;
    var btn = $('#btn-rescan');
    btn.disabled = true;
    btn.textContent = '\u21BB Scanning...';
    setStatus('Rescanning directory...');

    var result = await api('/stations/' + stationId + '/scan', { method: 'POST' });

    btn.disabled = false;
    btn.textContent = '\u21BB Rescan';

    if (!result.ok) {
      setStatus('Scan error: ' + result.error);
      return;
    }

    setStatus('Rescan complete: ' + result.tracks_found + ' tracks found');
    await loadStations();
    await loadTracks(stationId);
  });

  // ===================== Users (admin only) =====================
  async function loadUsers() {
    var list = $('#user-list');
    list.innerHTML = '<tr><td colspan="5" class="loading-row">Loading users\u2026</td></tr>';

    var result = await api('/users');
    if (!result.ok) {
      list.innerHTML = '<tr><td colspan="5" class="loading-row">Error: ' + result.error + '</td></tr>';
      return;
    }

    list.innerHTML = '';
    result.users.forEach(function (user) {
      var isSelf = user.id === state.user.id;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + user.id + '</td>' +
        '<td>' + esc(user.username) + '</td>' +
        '<td><span class="role-badge ' + user.role + '">' + user.role + '</span></td>' +
        '<td>' + user.created_at + '</td>' +
        '<td>' + (isSelf
          ? '<span style="color:#888;font-size:0.75rem;">(you)</span>'
          : '<button class="btn btn-sm btn-danger" data-action="delete-user" data-user-id="' + user.id + '">&#10006; Delete</button>') +
        '</td>';
      list.appendChild(tr);
    });
  }

  $('#user-list').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-action="delete-user"]');
    if (!btn) return;
    var userId = parseInt(btn.dataset.userId, 10);
    var users = await api('/users');
    var user = users.ok ? users.users.find(function (u) { return u.id === userId; }) : null;
    if (!user) return;

    showConfirm('Delete user "' + user.username + '"?', async function () {
      var result = await api('/users/' + userId, { method: 'DELETE' });
      if (!result.ok) {
        setStatus('Error: ' + result.error);
        return;
      }
      await loadUsers();
      setStatus('User "' + user.username + '" deleted');
    });
  });

  var addUserDialog = $('#add-user-dialog');
  $('#btn-add-user').addEventListener('click', function () {
    addUserDialog.classList.add('active');
    $('#new-username').focus();
  });

  $('#add-user-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var username = $('#new-username').value.trim();
    var password = $('#new-password').value;
    var role = $('#new-role').value;
    var errorMsg = $('#add-user-error');
    if (!username || !password) return;

    var result = await api('/users', {
      method: 'POST',
      body: JSON.stringify({ username: username, password: password, role: role }),
    });

    if (!result.ok) {
      errorMsg.textContent = result.error || 'Failed to create user';
      return;
    }

    addUserDialog.classList.remove('active');
    this.reset();
    errorMsg.textContent = '';
    await loadUsers();
    setStatus('User "' + username + '" created as ' + role);
  });

  // ===================== Logs (admin only) =====================
  async function loadLogs() {
    var list = $('#log-list');
    list.innerHTML = '<tr><td colspan="5" class="loading-row">Loading logs\u2026</td></tr>';

    var result = await api('/logs');
    if (!result.ok) {
      list.innerHTML = '<tr><td colspan="5" class="loading-row">Error: ' + result.error + '</td></tr>';
      return;
    }

    list.innerHTML = '';
    if (result.logs.length === 0) {
      list.innerHTML = '<tr><td colspan="5" class="loading-row">No activity yet.</td></tr>';
      return;
    }

    result.logs.forEach(function (log) {
      var tr = document.createElement('tr');
      var actionClass = log.action.replace(/\s+/g, '_');
      tr.innerHTML =
        '<td>' + log.created_at + '</td>' +
        '<td>' + esc(log.username || 'system') + '</td>' +
        '<td><span class="log-action ' + actionClass + '">' + esc(log.action) + '</span></td>' +
        '<td class="log-detail">' + esc(log.detail || '\u2014') + '</td>' +
        '<td class="log-ip">' + esc(log.ip || '\u2014') + '</td>';
      list.appendChild(tr);
    });
  }

  $('#btn-refresh-logs').addEventListener('click', loadLogs);

  // ===================== Confirm Dialog =====================
  // ===================== AI News (admin only) =====================
  async function loadAiNews() {
    var keyInput = $('#ai-api-key');
    var modelSelect = $('#ai-model');
    var statusEl = $('#ai-news-status');
    var textDisplay = $('#ai-news-text-display');
    var toggleBtn = $('#btn-toggle-news');
    var generateBtn = $('#btn-generate-news');

    var result = await api('/ai-news/config');
    if (!result.ok) { statusEl.textContent = 'Error: ' + result.error; return; }

    keyInput.placeholder = result.has_key ? 'Key saved (enter new one to replace)' : 'sk-...';
    modelSelect.value = result.model || 'deepseek-chat';

    if (result.enabled) {
      toggleBtn.textContent = 'Disable News';
      toggleBtn.className = 'btn btn-danger';
    } else {
      toggleBtn.textContent = 'Enable News';
      toggleBtn.className = 'btn';
    }
    toggleBtn.disabled = !result.has_key;
    toggleBtn.dataset.enabled = result.enabled ? '1' : '0';
    generateBtn.disabled = false;

    if (result.news_text) textDisplay.textContent = result.news_text;
    if (result.generated_at) statusEl.textContent = 'Last generated: ' + result.generated_at;
  }

  $('#btn-save-ai-key').addEventListener('click', async function () {
    var key = $('#ai-api-key').value.trim();
    var model = $('#ai-model').value;
    if (!key) { setStatus('Enter an API key'); return; }
    var result = await api('/ai-news/key', {
      method: 'POST',
      body: JSON.stringify({ api_key: key, model: model }),
    });
    if (result.ok) {
      $('#ai-api-key').value = '';
      setStatus('AI News config saved (model: ' + model + ')');
      await loadAiNews();
    } else {
      setStatus('Error: ' + result.error);
    }
  });

  $('#btn-generate-news').addEventListener('click', async function () {
    var btn = $('#btn-generate-news');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    setStatus('Generating AI news via DeepSeek...');
    var result = await api('/ai-news/generate', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = '\u25B6 Generate News';
    if (result.ok) {
      setStatus('AI news generated successfully');
      await loadAiNews();
    } else {
      setStatus('Error: ' + result.error);
    }
  });

  $('#btn-toggle-news').addEventListener('click', async function () {
    var btn = $('#btn-toggle-news');
    var enabled = btn.dataset.enabled === '1' ? false : true;
    var result = await api('/ai-news/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: enabled }),
    });
    if (result.ok) {
      setStatus(enabled ? 'AI News enabled' : 'AI News disabled');
      await loadAiNews();
    } else {
      setStatus('Error: ' + result.error);
    }
  });

  // ===================== Confirm Dialog =====================

  var confirmDialog = $('#confirm-dialog');
  var confirmCallback = null;

  function showConfirm(message, callback) {
    $('#confirm-message').textContent = message;
    confirmCallback = callback;
    confirmDialog.classList.add('active');
  }

  $('#confirm-yes').addEventListener('click', function () {
    confirmDialog.classList.remove('active');
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });

  // ===================== Dialog Close Buttons =====================
  $$('.dialog-close').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.closest('.dialog-overlay').classList.remove('active');
    });
  });

  $$('.dialog-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.classList.remove('active');
    });
  });

  // ===================== Player Controls =====================
  var tuneInBtn = $('#btn-tunein');
  var disconnectBtn = $('#btn-disconnect');
  var volumeSlider = $('#volume-slider');
  var volumeValue = $('#volume-value');

  tuneInBtn.addEventListener('click', function () {
    if (!state.currentStation) {
      setStatus('Please select a station first');
      return;
    }
    if (state.currentStation.stream_url || state.currentStation.is_playing) {
      tuneIntoStation(state.currentStation.id);
    } else {
      setStatus('Station is not broadcasting');
    }
  });

  disconnectBtn.addEventListener('click', disconnectFromStation);

  volumeSlider.addEventListener('input', function () {
    state.volume = parseInt(volumeSlider.value, 10);
    volumeValue.textContent = state.volume + '%';
    volumeSlider.style.background =
      'linear-gradient(to right, var(--win-green) 0%, var(--win-green) ' + state.volume + '%, #ddd ' + state.volume + '%)';
    if (state.audioElement) {
      state.audioElement.volume = state.volume / 100;
    }
  });

  // ===================== Audio Visualizer =====================
  var canvas = $('#visualizer');
  var ctx = canvas.getContext('2d');

  function resizeCanvas() {
    var container = canvas.parentElement;
    canvas.width = container.clientWidth - 4;
    canvas.height = 36;
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function startVisualizer() {
    if (state.animationId) return;
    animateVisualizer();
  }

  function stopVisualizer() {
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
      state.animationId = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawIdleVisualizer();
  }

  function animateVisualizer() {
    if (!state.isTunedIn) return;
    var barCount = Math.floor(canvas.width / 4);
    var barWidth = 2;
    var gap = 2;
    var maxH = canvas.height - 4;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Get real frequency data if available, otherwise use fake data
    var freqData;
    if (state.analyser) {
      freqData = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(freqData);
    }

    for (var i = 0; i < barCount; i++) {
      var height;
      if (freqData) {
        // Map frequency bins to bar positions (256 bins, skip first few bass bins)
        var bin = Math.floor((i / barCount) * (freqData.length - 4)) + 2;
        var val = freqData[Math.min(bin, freqData.length - 1)] / 255;
        height = Math.max(2, val * val * maxH); // square for visual punch
      } else {
        // Fallback: fake animation
        var time = Date.now() / 200;
        var freq = Math.sin(time + i * 0.3) * 0.5 + 0.5;
        var amp = Math.sin(time * 0.7 + i * 0.15) * 0.3 + 0.7;
        var noise = Math.random() * 0.2;
        height = Math.max(2, (freq * amp + noise) * maxH);
      }

      var ratio = height / maxH;
      var r, g, b;
      if (ratio < 0.5) {
        r = 0; g = Math.floor(200 + ratio * 112); b = 0;
      } else {
        r = Math.floor((ratio - 0.5) * 2 * 200);
        g = Math.floor(255 - (ratio - 0.5) * 2 * 100);
        b = 0;
      }

      ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      ctx.fillRect(i * (barWidth + gap), canvas.height - height, barWidth, height);
    }

    state.animationId = requestAnimationFrame(animateVisualizer);
  }

  function drawIdleVisualizer() {
    var barCount = Math.floor(canvas.width / 4);
    var barWidth = 2;
    var gap = 2;
    var idleH = 3;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < barCount; i++) {
      ctx.fillStyle = '#224422';
      ctx.fillRect(i * (barWidth + gap), canvas.height - idleH, barWidth, idleH);
    }
  }

  // ===================== Status Bar =====================
  var statusText = $('#status-text');
  var statusTime = $('#status-time');

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  function updateClock() {
    statusTime.textContent = new Date().toLocaleTimeString();
  }

  setInterval(updateClock, 1000);
  updateClock();

  // ===================== Keyboard Shortcuts =====================
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      $$('.dialog-overlay.active').forEach(function (d) { d.classList.remove('active'); });
    }
  });

  // ===================== Utility =====================
  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '\u2014';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ===================== Init =====================
  drawIdleVisualizer();
  checkSession();

})();
