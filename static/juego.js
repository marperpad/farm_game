// juego.js — Hundir la Granja (cliente)
// UN SOLO TABLERO: muestra tus estructuras + todos los disparos de todos los jugadores
(function(){
  'use strict';

  const qs = (s, el=document) => el.querySelector(s);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  const boardEl        = qs('#gameBoard');
  const turnPlayerEl   = qs('#turnPlayer');
  const turnAvatarEl   = qs('#turnAvatar');
  const powersListEl   = qs('#powersList');
  const commentsListEl = qs('#commentsList');
  const usePowerBtn    = qs('#usePowerBtn');
  const playersListEl  = qs('#playersList');
  const exitGameBtn    = qs('#exitGameBtn');
  const liveRegion     = qs('#gameLiveRegion');
  const boardTitleEl   = qs('.game-board-title');

  const structureModal = qs('#structureModal');
  const closeStructBtn = qs('#closeStructureModal');
  const ackStructBtn   = qs('#ackStructureModal');
  const structureMsgEl = qs('#structureMessage');
  const titleMsgEl = qs('#tituloModal');

  
const introModal = document.getElementById('introStoryModal');
const startStoryBtn = document.getElementById('startStoryBtn');

const rivalsModal = document.getElementById('rivalsModal');
const rivalsList = document.getElementById('rivalsList');
const rivalsReadyBtn = document.getElementById('rivalsReadyBtn');



  const urlParams   = new URLSearchParams(window.location.search);
  const roomCode    = (urlParams.get('codigo') || localStorage.getItem('codigo') || '').toUpperCase();
  const myName      = (localStorage.getItem('nombre') || 'Jugador').trim();
  const myAvatarKey = (localStorage.getItem('avatar') || 'granjero').trim();

  const hasSocket = typeof io === 'function';
  const socket = hasSocket ? io({ transports:['websocket','polling'] }) : null;

  const PLAYER_COLORS = [
    { hit:'#e74c3c', miss:'#e74c3c80', label:'Rojo' },
    { hit:'#3498db', miss:'#3498db80', label:'Azul' },
    { hit:'#f39c12', miss:'#f39c1280', label:'Naranja' },
    { hit:'#9b59b6', miss:'#9b59b680', label:'Morado' },
    { hit:'#1abc9c', miss:'#1abc9c80', label:'Turquesa' },
    { hit:'#e67e22', miss:'#e67e2280', label:'Ámbar' },
    { hit:'#2ecc71', miss:'#2ecc7180', label:'Verde' },
    { hit:'#e84393', miss:'#e8439380', label:'Rosa' },
    { hit:'#00cec9', miss:'#00cec980', label:'Cyan' },
    { hit:'#fdcb6e', miss:'#fdcb6e80', label:'Dorado' },
  ];

  const INSTANT_POWERS = ['doble_tiro', 'mover_estructura', 'senial'];

  const state = {
    players: [],
    myId: null,
    myColorIndex: 0,
    currentTurnPlayerId: null,
    boardSize: 12,
    myBoard: null,
    myPowers: [],
    selectedPower: null,
    revealedCells: [],  // [{x, y, has, decoy}] — celdas reveladas por poder 2x2
    scannedRows: [],    // [{row, hasAny}] — filas escaneadas (permanente)
    scannedCols: [],    // [{col, hasAny}] — columnas escaneadas (permanente)
    turnDeadline: 0,
    turnTimerInterval: null,
  };

  
  // Narrativa y advertencias por granjero (conectadas con mecánicas)
  const farmerLore = {
    granjero: {
      title: 'Granjero',
      text: '🌾 Estructuras equilibradas en tamaño y cantidad. No tiene trucos especiales, pero tampoco puntos débiles.'
    },
    vaquera: {
      title: 'Vaquera',
      text: '🎭 Tiene una trampa oculta entre sus estructuras. Si la impactas, el golpe no cuenta — cuidado con los falsos positivos.'
    },
    vaquero: {
      title: 'Vaquero',
      text: '🤠 Estructuras grandes y visibles. Fáciles de encontrar, pero cubren mucho terreno.'
    },
    horticultor: {
      title: 'Hortelana',
      text: '🥕 Muchas piezas pequeñas repartidas por todo el tablero. Encontrarlas todas será un reto de paciencia.'
    },
    apicultor: {
      title: 'Apicultor',
      text: '🐝 Sus colmenas se mueven una celda cada ronda. Donde disparaste antes podría estar vacío ahora.'
    },
    ranchero: {
      title: 'Ranchero',
      text: '🐄 Pocas estructuras, pero cada una necesita dos impactos para hundirse. Un solo golpe no basta.'
    }
  };


  function getColor(ci){ return PLAYER_COLORS[(ci||0) % PLAYER_COLORS.length]; }

  function normalizeAvatar(key){
    const k = String(key || '').toLowerCase();
    if (k.startsWith('granjer')) return 'granjero';
    if (k.startsWith('apicul'))  return 'apicultor';
    if (k.startsWith('vaquer'))  return 'vaquera';
    if (k.startsWith('horti'))   return 'horticultor';
    if (k.startsWith('ranch'))   return 'ranchero';
    return k || 'granjero';
  }

  function getAvatarUrl(key){
    const map = {
      'granjero':'/static/Granjero.png',
      'apicultor':'/static/Apicultor.png',
      'vaquera':'/static/Vaquera.png',
      'horticultor':'/static/Horticultor.png',
      'ranchero':'/static/Ranchero.png'
    };
    return map[normalizeAvatar(key)] || '/static/Granjero.png';
  }

  /* ---- Render ---- */

  function renderPlayersList(){
    playersListEl.innerHTML = '';
    state.players.forEach(p => {
      const color = getColor(p.colorIndex || 0);
      const li = document.createElement('li');
      li.className = 'player-item'
        + (p.isMe ? ' is-me' : '')
        + (p.eliminated ? ' eliminated' : '');
      li.innerHTML = `
        <span class="player-color-dot" style="background:${color.hit}"></span>
        <div class="player-item__avatar"><img src="${getAvatarUrl(p.avatar)}" alt="${p.nombre}"></div>
        <div class="player-item__name">${p.nombre}${p.isMe ? ' (tú)' : ''}${p.eliminated ? ' 💀' : ''}</div>
      `;
      playersListEl.appendChild(li);
    });
  }

  function renderBoard(){
    const n = state.boardSize;
    // Grid con fila y columna extra para encabezados de coordenadas
    boardEl.style.gridTemplateColumns = `24px repeat(${n}, 1fr)`;
    boardEl.style.gridTemplateRows    = `24px repeat(${n}, 1fr)`;
    boardEl.innerHTML = '';

    if (state.currentTurnPlayerId === state.myId) {
      boardTitleEl.textContent = '¡Tu turno!';
    } else {
      boardTitleEl.textContent = 'Tu Granja';
    }

    // Celda esquina vacía (arriba-izquierda)
    const corner = document.createElement('div');
    corner.className = 'board-coord board-coord--corner';
    boardEl.appendChild(corner);

    // Encabezados de columna (números arriba)
    for (let x=0; x<n; x++){
      const hdr = document.createElement('div');
      hdr.className = 'board-coord board-coord--col';
      hdr.textContent = x + 1;
      boardEl.appendChild(hdr);
    }

    // Filas del tablero
    for (let y=0; y<n; y++){
      // Encabezado de fila (número a la izquierda)
      const rowHdr = document.createElement('div');
      rowHdr.className = 'board-coord board-coord--row';
      rowHdr.textContent = y + 1;
      boardEl.appendChild(rowHdr);

      for (let x=0; x<n; x++){
        const cell = state.myBoard?.[y]?.[x] || { empty:true };
        const div = document.createElement('button');
        div.type = 'button';
        div.className = 'game-cell';
        div.dataset.x = x;
        div.dataset.y = y;

        const sc = cell.shooterColor;
        const hasSC = sc !== undefined && sc !== null;

        if (cell.hit){
          div.classList.add('hit');
          if (!cell.empty) div.classList.add('structure');
          const hpLeft = cell.hp ?? 0;
          if (hasSC){
            const c = getColor(sc);
            if (hpLeft > 0) {
              div.style.background = c.miss;
              div.style.borderColor = c.miss;
              div.classList.add('hit-damaged');
            } else {
              div.style.background = c.hit;
              div.style.borderColor = c.hit;
            }
          }
          div.textContent = hpLeft > 0 ? '⚠' : '✕';
        } else if (cell.miss){
          div.classList.add('miss');
          if (hasSC){
            const c = getColor(sc);
            div.style.background = c.miss;
          }
          div.textContent = '•';
        } else if (!cell.empty){
          div.classList.add('structure');
        }

        on(div, 'click', ()=> handleCellClick(x, y));

        // Overlay de revelación (poder 2x2)
        const revealed = state.revealedCells.find(r => r.x === x && r.y === y);
        if (revealed) {
          div.classList.add('revealed');
          if (revealed.has) {
            div.classList.add('revealed-has');
            div.textContent = revealed.decoy ? '🪤' : '🏠';
          } else {
            div.classList.add('revealed-empty');
            div.textContent = '💨';
          }
        }

        // Resaltar filas y columnas escaneadas (permanente)
        const rowScan = state.scannedRows.find(r => r.row === y);
        const colScan = state.scannedCols.find(c => c.col === x);
        if (rowScan) {
          div.classList.add('scanned-row');
          div.classList.add(rowScan.hasAny ? 'scanned-has' : 'scanned-empty');
          if (x === n - 1) div.classList.add('scanned-row-end');
        }
        if (colScan) {
          div.classList.add('scanned-col');
          div.classList.add(colScan.hasAny ? 'scanned-has' : 'scanned-empty');
          if (y === n - 1) div.classList.add('scanned-col-end');
        }

        boardEl.appendChild(div);
      }
    }
  }

  function renderPowers(){
    powersListEl.innerHTML = '';
    if (!state.myPowers.length){
      powersListEl.innerHTML = '<li style="font-size:12px;color:#999;padding:6px">Sin poderes</li>';
      usePowerBtn.disabled = true;
      return;
    }
    state.myPowers.forEach(pwr => {
      const li = document.createElement('li');
      const isActive = state.selectedPower?.key === pwr.key;
      li.className = 'power-item' + (isActive ? ' active' : '');
      const isInstant = INSTANT_POWERS.includes(pwr.key);
      li.innerHTML = `<span>${pwr.label}</span><small style="color:#999;font-size:11px">${isInstant ? '(auto)' : '(celda)'}</small>`;
      on(li, 'click', ()=>{
        state.selectedPower = isActive ? null : pwr;
        usePowerBtn.disabled = !state.selectedPower;
        renderPowers();
      });
      powersListEl.appendChild(li);
    });
    usePowerBtn.disabled = !state.selectedPower;
  }

  function renderComment(msg){
    const li = document.createElement('li');
    li.textContent = msg;
    commentsListEl.appendChild(li);
    commentsListEl.scrollTop = commentsListEl.scrollHeight;
  }

  function setTurnInfo(name, avatar){
    turnPlayerEl.textContent = name || '—';
    if (turnAvatarEl) turnAvatarEl.src = getAvatarUrl(avatar);
    // Visual "It's Your Turn" indicator
    const wrapper = qs('.game-board-wrapper');
    if (wrapper) {
      if (state.currentTurnPlayerId === state.myId) {
        wrapper.classList.add('my-turn');
        if (boardTitleEl) boardTitleEl.textContent = '¡Tu turno!';
      } else {
        wrapper.classList.remove('my-turn');
        if (boardTitleEl) boardTitleEl.textContent = 'Tu Granja';
      }
    }
  }

  function startTurnTimer(deadline, duration){
    state.turnDeadline = deadline || (Date.now()/1000 + (duration || 30));
    if (state.turnTimerInterval) clearInterval(state.turnTimerInterval);
    updateTurnTimer();
    state.turnTimerInterval = setInterval(updateTurnTimer, 250);
  }

  function updateTurnTimer(){
    const el = qs('#turnTimer');
    if (!el) return;
    const remaining = Math.max(0, Math.ceil(state.turnDeadline - Date.now()/1000));
    el.textContent = remaining + 's';
    if (remaining <= 5) {
      el.classList.add('urgent');
    } else {
      el.classList.remove('urgent');
    }
    if (remaining <= 0) {
      el.textContent = '⏰ Tiempo agotado';
      if (state.turnTimerInterval) { clearInterval(state.turnTimerInterval); state.turnTimerInterval = null; }
    }
  }

  function announce(msg){
    if (liveRegion){ liveRegion.textContent = ''; setTimeout(()=> liveRegion.textContent = msg, 20); }
    renderComment(msg);
  }

  function openModal(msg,title){
    if (!structureModal) return;
    titleMsgEl.textContent = title || 'Resultado del Impacto';
    structureMsgEl.textContent = msg || '—';
    structureModal.classList.add('is-open');
  }
  function closeModal(){ structureModal && structureModal.classList.remove('is-open'); }
  on(closeStructBtn, 'click', closeModal);
  on(ackStructBtn, 'click', closeModal);


  function showRivalsModal(players){
    rivalsList.innerHTML = '';

    players.forEach(p => {
      const roleKey = normalizeAvatar(p.avatar || 'granjero');
      const lore = farmerLore[roleKey] || farmerLore.granjero;

      const card = document.createElement('div');
      card.className = 'rival-card';
      card.innerHTML = `
        <div class="rival-avatar">
          <img src="${getAvatarUrl(p.avatar)}" alt="${lore.title}">
        </div>
        <div class="rival-info">
          <div class="rival-name">${p.nombre}</div>
          <div class="rival-role">${lore.title}</div>
          <div class="rival-story">${lore.text}</div>
        </div>
      `;
      rivalsList.appendChild(card);
    });

    rivalsModal.classList.add('is-open');
  }
  
  // Cerrar el modal de rivales → abrir tutorial
  if (rivalsReadyBtn){
    rivalsReadyBtn.addEventListener('click', () => {
      rivalsModal.classList.remove('is-open');
      const tutorialModal = document.getElementById('tutorialModal');
      if (tutorialModal) tutorialModal.classList.add('is-open');
    });
  }

  // Cerrar tutorial → comenzar a jugar
  const tutorialReadyBtn = document.getElementById('tutorialReadyBtn');
  if (tutorialReadyBtn){
    tutorialReadyBtn.addEventListener('click', () => {
      const tutorialModal = document.getElementById('tutorialModal');
      if (tutorialModal) tutorialModal.classList.remove('is-open');
      document.body.style.overflow = '';
      const live = document.getElementById('gameLiveRegion');
      if (live) live.textContent = 'La contienda ha comenzado.';
    });
  }


  /* ---- Interacciones ---- */

  function handleCellClick(x, y){
    // Poder instantáneo seleccionado: activarlo antes de disparar
    if (state.selectedPower && INSTANT_POWERS.includes(state.selectedPower.key)){
      activateInstantPower(state.selectedPower);
      // Después de activar, ejecutar el disparo normalmente
      fireAt(x, y);
      return;
    }
    // Poder con celda seleccionado
    if (state.selectedPower){
      usePowerAtCell(x, y);
      return;
    }
    fireAt(x, y);
  }

  if (startStoryBtn && introModal){
    startStoryBtn.addEventListener('click', () => {
      introModal.classList.remove('is-open');
      
      // Mostrar modal de rivales
      showRivalsModal(state.players);

      // Narrador accesible
      const live = document.getElementById('gameLiveRegion');
      if (live) live.textContent = 'Conoce a tus rivales.';
    });
  }

  on(usePowerBtn, 'click', ()=>{
    const pwr = state.selectedPower;
    if (!pwr) return;
    if (INSTANT_POWERS.includes(pwr.key)){
      activateInstantPower(pwr);
    } else {
      announce(`Haz click en una celda para usar "${pwr.label}".`);
    }
  });

  function activateInstantPower(pwr){
    if (!socket) return;
    socket.emit('usar_poder', {
      room: roomCode, x: 0, y: 0,
      power: pwr.key,
      targetId: state.myId
    });
    announce(`Poder activado: ${pwr.label}`);
    state.selectedPower = null;
    // No quitar el poder aquí — se quita cuando el servidor confirme en poder_resultado
    renderPowers();
  }

  function usePowerAtCell(x, y){
    const pwr = state.selectedPower;
    if (!pwr || !socket) return;
    socket.emit('usar_poder', {
      room: roomCode, x, y,
      power: pwr.key
    });
    announce(`Poder "${pwr.label}" en (${x+1},${y+1})`);
    state.selectedPower = null;
    // No quitar el poder aquí — se quita cuando el servidor confirme en poder_resultado
    renderPowers();
  }

  function fireAt(x, y){
    if (socket) socket.emit('disparo', { room: roomCode, x, y });
  }

  /* ---- Init ---- */

  function bootstrapUI(){
    if (!state.players.length){
      state.players = [{ id:'me', nombre: myName, avatar: myAvatarKey, isMe:true, colorIndex:0 }];
      state.myId = 'me';
      state.currentTurnPlayerId = 'me';
    }
    renderPlayersList();
    setTurnInfo(myName, myAvatarKey);
    renderPowers();
  }

  on(exitGameBtn, 'click', ()=>{ window.location.href = '/'; });

  /* ---- Socket ---- */
  if (socket){
    socket.on('connect', () => {
      const overlay = document.getElementById('reconnectOverlay');
      if (overlay) overlay.classList.remove('is-visible');
      socket.emit('join_game', { room: roomCode, nombre: myName, avatar: myAvatarKey });
    });

    socket.on('estado_juego', (data) => {
      try{
        state.players = (data.players || []).map(p => ({
          ...p, isMe: p.id === data.you?.id, colorIndex: p.colorIndex ?? 0
        }));
        state.myId = data.you?.id || state.myId;
        state.myColorIndex = data.you?.colorIndex ?? 0;
        state.currentTurnPlayerId = data.turnoActualId;
        if (data.boardSize) state.boardSize = data.boardSize;
        if (Array.isArray(data.powers)) state.myPowers = data.powers;

        renderPlayersList();
        const turnP = state.players.find(p=>p.id===state.currentTurnPlayerId);
        setTurnInfo(turnP?.nombre || '—', turnP?.avatar);
        renderPowers();

        if (data.deadline) startTurnTimer(data.deadline, data.duration);

        if (Array.isArray(data.myStructures)){
          state.myBoard = data.myStructures;
          renderBoard();
        }
      }catch(e){ console.error('Error estado_juego', e); }
    });

    // Broadcast: disparo afecta a todos los enemigos
    socket.on('resultado_disparo_broadcast', ({ x, y, shooterName, shooterColor, results }) => {
      const who = shooterName || 'Alguien';
      const color = getColor(shooterColor ?? 0);

      // Filtrar solo resultados con impacto real (no already)
      const realResults = results.filter(r => !r.already);
      const hits = realResults.filter(r => r.hit);
      const misses = realResults.filter(r => !r.hit);

      if (hits.length === 0) {
        const title ='💨 Golpe al vacío';
        const msg = `${who} lanzó un ataque en (${x+1},${y+1}), pero solo levantó polvo. La llanura sigue intacta.`;
        announce(msg);
        openModal(msg,title);
      } else {
        hits.forEach(r => {
          let msg;
          if (r.decoy) {
            msg = `🎭 ${who} atacó la granja de ${r.targetName} y cayó en una trampa. El golpe fue en vano.`;
          } else if (r.sunk) {
            msg = `🔥 ${who} destruyó ${r.structureName || 'una estructura'} de ${r.targetName}. Los cimientos se derrumban.`;
          } else if (r.hpLeft > 0) {
            msg = `⚠️ ${who} golpeó ${r.structureName || 'una estructura'} de ${r.targetName}, pero resiste. Necesita otro golpe para caer.`;
          } else {
            msg = `💥 ${who} impactó en la granja de ${r.targetName}. ${r.structureName || 'Estructura'} alcanzada.`;
          }
          announce(msg);
        });
        if (misses.length > 0) {
          announce(`💨 El ataque de ${who} no encontró nada en las granjas de ${misses.map(r=>r.targetName).join(', ')}.`);
        }
        // Modal con resumen
        const summary = hits.map(r => {
          if (r.decoy) return `🎭 ${r.targetName}: ¡Trampa! Golpe en vano.`;
          if (r.sunk) return `🔥 ${r.targetName}: ${r.structureName || 'Estructura'} destruida.`;
          if (r.hpLeft > 0) return `⚠️ ${r.targetName}: ${r.structureName || 'Estructura'} dañada, resiste.`;
          return `💥 ${r.targetName}: ${r.structureName || 'Estructura'} alcanzada.`;
        }).join('\n');
        openModal(summary,'⚔️ Resultado del ataque');
      }
    });

    socket.on('turno_siguiente', ({ turnoActualId, turnoActualAvatar, deadline, duration }) => {
      state.currentTurnPlayerId = turnoActualId;
      const turnP = state.players.find(p=>p.id===turnoActualId);
      setTurnInfo(turnP?.nombre || '—', turnoActualAvatar || turnP?.avatar);
      if (deadline) startTurnTimer(deadline, duration);

      // Limpiar celdas reveladas al cambiar de turno
      if (state.revealedCells.length > 0) {
        state.revealedCells = [];
        renderBoard();
      }
    });

    // El servidor envía el tablero actualizado al dueño tras cada disparo recibido
    socket.on('tablero_actualizado', ({ myStructures }) => {
      if (Array.isArray(myStructures)){
        state.myBoard = myStructures;
        renderBoard();
      }
    });

    // Un jugador ha perdido todas sus estructuras
    socket.on('jugador_eliminado', ({ playerId, playerName }) => {
      const msg = `💀 ${playerName} ha perdido todo su territorio en la Gran Llanura.`;
      announce(msg);

      // Marcar al jugador como eliminado en la lista
      const p = state.players.find(pl => pl.id === playerId);
      if (p) p.eliminated = true;
      renderPlayersList();
    });

    // Fin del juego — hay un ganador
    socket.on('juego_terminado', ({ winnerId, winnerName }) => {
      const gameOverModal = document.getElementById('gameOverModal');
      const gameOverTitle = document.getElementById('gameOverTitle');
      const gameOverMessage = document.getElementById('gameOverMessage');
      const gameOverExitBtn = document.getElementById('gameOverExitBtn');

      if (!gameOverModal) return;

      const isMe = winnerId === state.myId;

      gameOverTitle.textContent = isMe ? '🏆 ¡Victoria!' : '🌅 Fin de la contienda';

      gameOverMessage.textContent =
        `🌅 La llanura vuelve a guardar silencio.\nLas estructuras rivales han caído.\n\n` +
        `${winnerName} ha demostrado ser el granjero más astuto de la Gran Llanura.\n\n` +
        `Ahora, su visión guiará la reconstrucción…\nhasta que la próxima sequía vuelva a ponerlo todo en juego.`;

      gameOverModal.classList.add('is-open');
      announce(`🏆 ${winnerName} ha ganado la partida.`);

      // Deshabilitar el tablero
      boardEl.style.pointerEvents = 'none';
      boardEl.style.opacity = '0.6';

      if (gameOverExitBtn) {
        gameOverExitBtn.addEventListener('click', () => {
          window.location.href = '/';
        });
      }
    });

    socket.on('poder_resultado', (data) => {
      if (!data.ok){
        announce(`No se pudo usar el poder: ${data.error || 'error desconocido'}`);
        return;
      }

      // Consumir el poder de la lista local solo cuando el servidor confirma
      state.myPowers = state.myPowers.filter(p => p.key !== data.power);
      renderPowers();

      if (data.power === 'revelar_2x2'){
        const reveals = data.reveals || [];
        if (reveals.length === 0){
          announce('Revelación 2x2: No se encontraron enemigos activos.');
          openModal('No se encontraron enemigos activos en esa zona.', '🔍 Revelación 2x2');
          return;
        }

        // Marcar celdas reveladas en el tablero
        const rx = data.revealX ?? 0;
        const ry = data.revealY ?? 0;
        const n = state.boardSize;
        const newRevealed = [];

        // Consolidar: si ALGÚN enemigo tiene estructura en esa celda, marcar como "has"
        for (let dy = 0; dy < 2 && (ry + dy) < n; dy++) {
          for (let dx = 0; dx < 2 && (rx + dx) < n; dx++) {
            let anyHas = false;
            let anyDecoy = false;
            data.reveals.forEach(r => {
              const cellInfo = r.area[dy]?.[dx];
              if (cellInfo?.has) { anyHas = true; if (cellInfo.decoy) anyDecoy = true; }
            });
            newRevealed.push({ x: rx + dx, y: ry + dy, has: anyHas, decoy: anyDecoy });
          }
        }
        state.revealedCells = newRevealed;
        renderBoard();

        let lines = ['🔍 Revelación 2x2:'];
        data.reveals.forEach(r => {
          let icons = '';
          r.area.forEach(row => row.forEach(c => { icons += c.has ? (c.decoy ? '🪤' : '🏠') : '💨'; }));
          lines.push(`  ${r.targetName}: ${icons}`);
        });
        const msg = lines.join('\n');
        openModal(msg, '🔍 Revelación 2x2');
        lines.forEach(l => announce(l));
      }

      if (data.power === 'escanear_linea' && (data.rowScans || data.colScans)){
        const row = data.row ?? -1;
        const col = data.col ?? -1;
        const rowScans = data.rowScans || [];
        const colScans = data.colScans || [];

        if (rowScans.length === 0 && colScans.length === 0){
          announce('Escaneo: No hay enemigos activos.');
          return;
        }

        // Marcar fila escaneada (permanente)
        const rowHasAny = rowScans.some(s => s.hasAny);
        if (row >= 0 && !state.scannedRows.find(r => r.row === row)) {
          state.scannedRows.push({ row, hasAny: rowHasAny });
        }

        // Marcar columna escaneada (permanente)
        const colHasAny = colScans.some(s => s.hasAny);
        if (col >= 0 && !state.scannedCols.find(c => c.col === col)) {
          state.scannedCols.push({ col, hasAny: colHasAny });
        }

        renderBoard();

        let lines = [`📡 Escaneo en (${col + 1}, ${row + 1}):`];
        lines.push(`  Fila ${row + 1}: ${rowHasAny ? '¡Hay estructura!' : 'Vacía'}`);
        rowScans.forEach(s => { lines.push(`    ${s.targetName}: ${s.hasAny ? '⚠️ Sí' : '✅ No'}`); });
        lines.push(`  Columna ${col + 1}: ${colHasAny ? '¡Hay estructura!' : 'Vacía'}`);
        colScans.forEach(s => { lines.push(`    ${s.targetName}: ${s.hasAny ? '⚠️ Sí' : '✅ No'}`); });
        const msg = lines.join('\n');
        openModal(msg, '📡 Escaneo fila/columna');
        lines.forEach(l => announce(l));
      }

      if (data.power === 'doble_tiro') announce('¡Doble tiro activado! Disparo extra.');
      if (data.power === 'mover_estructura') {
        if (data.moved) {
          announce('Una estructura se movió.');
        } else {
          const msg = 'No se pudo mover ninguna estructura. Todas han recibido impactos.';
          announce(msg);
          openModal(msg, '🚫 Movimiento fallido');
        }
      }
      if (data.power === 'senial') announce('Señuelo colocado en tu tablero.');
    });
    socket.on('turno_timer', ({ deadline, duration }) => {
      startTurnTimer(deadline, duration);
    });

    socket.on('turno_auto_skip', ({ playerName }) => {
      announce(`⏰ ${playerName} perdió su turno por tiempo`);
    });

    // --- Auto-Reconnection ---
    socket.on('disconnect', () => {
      announce('⚠️ Conexión perdida. Reconectando...');
      const overlay = document.getElementById('reconnectOverlay');
      if (overlay) overlay.classList.add('is-visible');
    });

    socket.on('reconnect', () => {
      socket.emit('join_game', { room: roomCode, nombre: myName, avatar: myAvatarKey });
      announce('🔄 Reconectado al servidor.');
    });
  }

  bootstrapUI();
})();
