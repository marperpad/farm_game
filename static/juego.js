// juego.js — Hundir la Granja (cliente)
// UN SOLO TABLERO: muestra tus estructuras + todos los disparos de todos los jugadores
(function(){
  'use strict';

  const qs = (s, el=document) => el.querySelector(s);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  const boardEl        = qs('#gameBoard');
  const turnPlayerEl   = qs('#turnPlayer');
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
  };

  
  // Narrativa y advertencias por granjero
  const farmerLore = {
    granjero: {
      title: 'Granjero',
      text: '🌾 Equilibrio y adaptabilidad. Nunca subestimes su capacidad de responder.'
    },
    vaquera: {
      title: 'Vaquera',
      text: '🎭 No todo impacto es real. Usa trampas para confundir y hacerte dudar.'
    },
    vaquero: {
      title: 'Vaquero',
      text: '🤠 Grandes estructuras, visibles y sólidas. Derribarlas tomará estrategia.'
    },
    horticultor: {
      title: 'Hortelana',
      text: '🥕 Muchas piezas pequeñas, ocultas por todo el terreno. Encontrarlas será difícil.'
    },
    apicultor: {
      title: 'Apicultor',
      text: '🐝 Sus colmenas nunca están quietas. La certeza dura poco contra él.'
    },
    ranchero: {
      title: 'Ranchero',
      text: '🐄 Pocas estructuras, pero resistentes. Un golpe no será suficiente.'
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
    boardEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    boardEl.style.gridTemplateRows    = `repeat(${n}, 1fr)`;
    boardEl.innerHTML = '';

    boardTitleEl.textContent = 'Tu Granja';

    for (let y=0; y<n; y++){
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
              // Primer impacto: color claro (estructura resiste)
              div.style.background = c.miss;
              div.style.borderColor = c.miss;
              div.classList.add('hit-damaged');
            } else {
              // Hundida: color normal sólido
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

  function setTurnPlayerName(name){ turnPlayerEl.textContent = name || '—'; }

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
  
  // Cerrar el modal de rivales y comenzar a jugar
  if (rivalsReadyBtn){
    rivalsReadyBtn.addEventListener('click', () => {
      rivalsModal.classList.remove('is-open');
      document.body.style.overflow = '';
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
    state.myPowers = state.myPowers.filter(p => p.key !== pwr.key);
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
    state.myPowers = state.myPowers.filter(p => p.key !== pwr.key);
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
    setTurnPlayerName(myName);
    renderPowers();
  }

  on(exitGameBtn, 'click', ()=>{ window.location.href = '/'; });

  /* ---- Socket ---- */
  if (socket){
    socket.on('connect', () => {
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
        setTurnPlayerName(state.players.find(p=>p.id===state.currentTurnPlayerId)?.nombre || '—');
        renderPowers();

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
        const title ='❌ Fallo';
        const msg = `[${color.label}] ${who} disparó en (${x+1},${y+1}): El ataque no encontró nada útil.`;
        announce(msg);
        openModal(msg,title);
      } else {
        hits.forEach(r => {
          let msg;
          if (r.decoy) {
            msg = `[${color.label}] ${who} → ${r.targetName}: ¡Trampa! El golpe parecía certero, pero era solo una ilusión.`;
          } else if (r.sunk) {
            msg = `[${color.label}] ${who} → ${r.targetName}: ¡Hundido! ${r.structureName || 'Estructura'} destruida.`;
          } else if (r.hpLeft > 0) {
            msg = `[${color.label}] ${who} → ${r.targetName}: ¡Impacto en ${r.structureName || 'estructura'}! Pero resiste, necesita más golpes.`;
          } else {
            msg = `[${color.label}] ${who} → ${r.targetName}: ¡Impacto! ${r.structureName || ''}`;
          }
          announce(msg);
        });
        if (misses.length > 0) {
          announce(`[${color.label}] ${who}: El ataque no encontró nada útil en tableros de ${misses.map(r=>r.targetName).join(', ')}`);
        }
        // Modal con resumen de impactos
        const summary = hits.map(r => {
          if (r.decoy) return `${r.targetName}: ¡Trampa! El golpe parecía certero, pero era solo una ilusión.`;
          if (r.sunk) return `${r.targetName}: ¡Hundido! ${r.structureName || 'Estructura'} destruida.`;
          if (r.hpLeft > 0) return `${r.targetName}: ¡Impacto en ${r.structureName || 'estructura'}! Pero resiste, necesita más golpes.`;
          return `${r.targetName}: ¡Impacto! ${r.structureName || ''}`;
        }).join('\n');
        openModal(summary,'Resumen Impactos');
      }
    });

    socket.on('turno_siguiente', ({ turnoActualId }) => {
      state.currentTurnPlayerId = turnoActualId;
      setTurnPlayerName(state.players.find(p=>p.id===turnoActualId)?.nombre || '—');

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
      if (!data.ok){ announce('Error al usar poder.'); return; }

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
  }

  bootstrapUI();
})();
