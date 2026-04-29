# main.py
import math
import random
import string
import uuid
import time
import threading
import sqlite3
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_socketio import SocketIO, join_room, emit, leave_room,send

import os

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'farm_secret_key_dev_only')

# Socket.IO: en producción restringir CORS al dominio real
allowed_origins = os.environ.get('ALLOWED_ORIGINS', '*')
socketio = SocketIO(app, cors_allowed_origins=allowed_origins)

TURN_DURATION = 30

# ---------- SQLite persistence ----------
DB_PATH = os.environ.get('DB_PATH', 'game_state.db')

def _get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    conn = _get_db()
    conn.execute("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS game_states (code TEXT PRIMARY KEY, data TEXT)")
    conn.commit()
    conn.close()

def save_room(code):
    if code not in rooms:
        return
    try:
        data = json.dumps(rooms[code], default=str)
        conn = _get_db()
        conn.execute("INSERT OR REPLACE INTO rooms (code, data) VALUES (?, ?)", (code, data))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB] Error saving room {code}: {e}")

def serialize_room_state(state) -> str:
    return json.dumps({
        'code': state.code,
        'players': [{'id':p.id,'sid':p.sid,'nombre':p.nombre,'avatar':p.avatar,'room':p.room,'color_index':p.color_index,'extra_shots':p.extra_shots,'eliminated':p.eliminated} for p in state.players],
        'boards': state.boards,
        'board_size': state.board_size,
        'turn_idx': state.turn_idx,
        'round_count': state.round_count,
        'powers': state.powers,
        'turn_deadline': state.turn_deadline,
    })

def deserialize_room_state(data_str: str):
    d = json.loads(data_str)
    state = RoomState(code=d['code'])
    state.board_size = d['board_size']
    state.turn_idx = d['turn_idx']
    state.round_count = d['round_count']
    state.boards = d['boards']
    state.powers = d['powers']
    state.turn_deadline = d.get('turn_deadline', 0.0)
    for pd_item in d['players']:
        state.players.append(Player(**pd_item))
    return state

def save_game_state(code):
    if code not in rooms_game:
        return
    try:
        data = serialize_room_state(rooms_game[code])
        conn = _get_db()
        conn.execute("INSERT OR REPLACE INTO game_states (code, data) VALUES (?, ?)", (code, data))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB] Error saving game state {code}: {e}")

def load_all_state():
    try:
        conn = _get_db()
        for row in conn.execute("SELECT code, data FROM rooms"):
            try:
                rooms[row[0]] = json.loads(row[1])
            except Exception:
                pass
        for row in conn.execute("SELECT code, data FROM game_states"):
            try:
                rooms_game[row[0]] = deserialize_room_state(row[1])
            except Exception:
                pass
        conn.close()
        print(f"[DB] Loaded {len(rooms)} rooms, {len(rooms_game)} game states")
    except Exception as e:
        print(f"[DB] Error loading state: {e}")

# Estado en memoria
rooms : Dict[str, dict] = {}  # { codigo: { jugadores: [ {id, nombre, avatar, sid} ], juego_iniciado: bool, ... } }
user_sessions: Dict[str, str] = {}  # Mapeo de session_id a room_code

#ESTADO DE JUEGO
@dataclass
class Player:
    id: str
    sid: str
    nombre: str
    avatar: str
    room: str
    color_index: int = 0
    extra_shots: int = 0  # "doble_tiro"
    eliminated: bool = False

@dataclass
class RoomState:
    code: str
    players: List[Player] = field(default_factory=list)
    boards: Dict[str, List[List[dict]]] = field(default_factory=dict)  # player_id -> NxN celdas
    board_size: int = 12
    turn_idx: int = 0
    round_count: int = 0
    powers: Dict[str, List[dict]] = field(default_factory=dict)       # player_id -> [powers]
    turn_deadline: float = 0.0

rooms_game: Dict[str, RoomState] = {}  # code -> RoomState

STRUCT_NAMES = {
    'granero': 'Granero',
    'corral': 'Corral',
    'huerto': 'Huerto',
    'silo': 'Silo',
    'colmena': 'Colmena',
    'establo': 'Establo',
    'gallinero': 'Gallinero',
    'trampa': 'Trampa',
}
POWERS_POOL = [
    {'key': 'revelar_2x2',      'label': 'Revelar área 2x2'},
    {'key': 'mover_estructura', 'label': 'Mover 1 estructura'},
    {'key': 'senial',           'label': 'Casilla señuelo'},
    {'key': 'doble_tiro',       'label': 'Doble tiro'},
    {'key': 'escanear_linea',   'label': 'Escanear fila/columna'},
]

#Utilidades
def normalize_avatar(key: str) -> str:
    k = (key or '').strip().lower()
    if k.startswith('granjer'): return 'granjero'
    if k.startswith('apicul'):  return 'apicultor'
    if k.startswith('vaquer'):  return 'vaquera'
    if k.startswith('horti'):   return 'horticultor'
    if k.startswith('ranch'):   return 'ranchero'
    return k or 'granjero'

def loadout_for(avatar: str) -> List[dict]:
    a = normalize_avatar(avatar)
    if a in ('vaquera', 'vaquero', 'granjero_vaquero', 'ranchero_vaquero'):
        return [
            {'key':'granero', 'name':'Granero', 'size':5, 'count':1, 'hp':1},
            {'key':'corral',  'name':'Corral',  'size':3, 'count':2, 'hp':1},
        ]
    if a == 'horticultor':
        return [
            {'key':'huerto', 'name':'Huerto', 'size':2, 'count':4, 'hp':1},
            {'key':'silo',   'name':'Silo',   'size':1, 'count':4, 'hp':1},
        ]
    if a == 'apicultor':
        return [
            {'key':'colmena', 'name':'Colmena', 'size':2, 'count':3, 'hp':1, 'mobile': True},
            {'key':'silo',    'name':'Silo',    'size':1, 'count':1, 'hp':1},
        ]
    if a == 'ranchero':
        return [
            {'key':'establo',   'name':'Establo',   'size':4, 'count':1, 'hp':2},
            {'key':'gallinero', 'name':'Gallinero', 'size':3, 'count':1, 'hp':2},
        ]
    return [
        {'key':'granero', 'name':'Granero', 'size':4, 'count':1, 'hp':1},
        {'key':'corral',  'name':'Corral',  'size':3, 'count':1, 'hp':1},
        {'key':'silo',    'name':'Silo',    'size':1, 'count':1, 'hp':1},
    ]

def augment_for_specials(avatar: str, base: List[dict]) -> List[dict]:
    a = normalize_avatar(avatar)
    out = list(base)
    if a == 'vaquera':
        out.append({'key':'trampa', 'name':'Trampa', 'size':1, 'count':1, 'hp':1, 'decoy': True})
    return out

def total_cells(loadout: List[dict]) -> int:
    return sum((item['size'] * item.get('count', 1)) for item in loadout)

def calc_board_size(players_count: int, my_cells: int) -> int:
    p = max(1, players_count or 1)
    base = 12
    extra = math.ceil(math.sqrt(max(0, my_cells)) / 2)
    scaled = base + min(4, math.ceil((p-2)/2)) + extra
    return max(10, min(18, scaled))

def create_empty_board(n: int) -> List[List[dict]]:
    return [[{'empty': True} for _ in range(n)] for _ in range(n)]

def place_linear(board: List[List[dict]], size: int, struct_id: str, hp: int, decoy: bool=False, owner: str='') -> bool:
    n = len(board)
    for _ in range(500):
        vertical = random.random() < 0.5
        x = random.randrange(n)
        y = random.randrange(n)
        if vertical:
            if y + size > n: continue
            if any(not board[y+i][x].get('empty', True) for i in range(size)): continue
            for i in range(size):
                board[y+i][x] = {'empty': False, 'structId': struct_id, 'hp': hp, 'decoy': decoy, 'owner': owner}
            return True
        else:
            if x + size > n: continue
            if any(not board[y][x+i].get('empty', True) for i in range(size)): continue
            for i in range(size):
                board[y][x+i] = {'empty': False, 'structId': struct_id, 'hp': hp, 'decoy': decoy, 'owner': owner}
            return True
    return False

def build_board_for(avatar: str, n: int, owner: str='') -> List[List[dict]]:
    loadout = augment_for_specials(avatar, loadout_for(avatar))
    board = create_empty_board(n)
    counter = 0
    for item in loadout:
        count = item.get('count', 1)
        for _ in range(count):
            sid = f"{item['key']}-{owner[:8]}-{counter}"
            place_linear(board, item['size'], sid, item.get('hp', 1), item.get('decoy', False), owner=owner)
            counter += 1
    return board

def find_overlaps(boards: Dict[str, List[List[dict]]], n: int) -> List[tuple]:
    """Encuentra celdas (x, y) donde más de un jugador tiene estructura.
    Retorna lista de (x, y, [player_ids con estructura ahí])."""
    conflicts = []
    for y in range(n):
        for x in range(n):
            owners_at = []
            for pid, board in boards.items():
                cell = board[y][x]
                if not cell.get('empty', True) and cell.get('owner'):
                    owners_at.append(pid)
            if len(owners_at) > 1:
                conflicts.append((x, y, owners_at))
    return conflicts

def relocate_structure(board: List[List[dict]], struct_id: str, occupied_coords: set, n: int) -> bool:
    """Reubica una estructura completa en una posición libre del tablero.
    occupied_coords es un set de (x,y) que están ocupadas por OTROS jugadores."""
    # Recopilar celdas actuales de la estructura
    cells = []
    template = None
    for y in range(n):
        for x in range(n):
            if board[y][x].get('structId') == struct_id:
                cells.append((x, y))
                if not template:
                    template = {k: v for k, v in board[y][x].items() if k != 'structId'}
    if not cells or not template:
        return False

    size = len(cells)
    # Determinar orientación original
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]

    # Limpiar posición actual
    for (cx, cy) in cells:
        board[cy][cx] = {'empty': True}

    # Intentar reubicar en posición aleatoria
    for _ in range(1000):
        vertical = random.random() < 0.5
        sx = random.randrange(n)
        sy = random.randrange(n)
        new_cells = []
        if vertical:
            if sy + size > n:
                continue
            for i in range(size):
                new_cells.append((sx, sy + i))
        else:
            if sx + size > n:
                continue
            for i in range(size):
                new_cells.append((sx + i, sy))

        # Verificar que todas las celdas estén libres en el propio tablero y no ocupadas por otros
        ok = True
        for (nx, ny) in new_cells:
            own_cell = board[ny][nx]
            if not own_cell.get('empty', True):
                ok = False
                break
            if (nx, ny) in occupied_coords:
                ok = False
                break
        if not ok:
            continue

        # Colocar
        for (nx, ny) in new_cells:
            board[ny][nx] = {**template, 'structId': struct_id}
        return True

    # Si no se pudo reubicar, restaurar en posición original (fallback)
    for (cx, cy) in cells:
        board[cy][cx] = {**template, 'structId': struct_id}
    return False

def resolve_all_overlaps(boards: Dict[str, List[List[dict]]], n: int, max_iterations: int = 100):
    """Revisa que las estructuras de los jugadores no se sobrepongan.
    Si alguna se sobrepone, reubica una de las estructuras y vuelve a revisar.
    Solo sale cuando no hay sobreposiciones o se alcanza el límite de iteraciones."""
    for iteration in range(max_iterations):
        conflicts = find_overlaps(boards, n)
        if not conflicts:
            return  # Sin sobreposiciones, listo

        # Tomar el primer conflicto
        x, y, owner_ids = conflicts[0]

        # Elegir al jugador que se va a mover (el último en la lista, para no mover siempre al mismo)
        mover_id = owner_ids[-1]
        mover_board = boards[mover_id]
        cell = mover_board[y][x]
        struct_id = cell.get('structId')

        if not struct_id:
            continue

        # Calcular coordenadas ocupadas por OTROS jugadores (excluyendo al que se mueve)
        occupied = set()
        for pid, board in boards.items():
            if pid == mover_id:
                continue
            for oy in range(n):
                for ox in range(n):
                    if not board[oy][ox].get('empty', True):
                        occupied.add((ox, oy))

        relocate_structure(mover_board, struct_id, occupied, n)

def build_board_avoiding(avatar: str, n: int, owner: str, occupied: set) -> List[List[dict]]:
    """Genera un tablero colocando estructuras sin pisar coordenadas ya ocupadas por otros."""
    loadout = augment_for_specials(avatar, loadout_for(avatar))
    board = create_empty_board(n)
    counter = 0
    for item in loadout:
        count = item.get('count', 1)
        for _ in range(count):
            sid = f"{item['key']}-{owner[:8]}-{counter}"
            _place_linear_avoiding(board, item['size'], sid, item.get('hp', 1),
                                   item.get('decoy', False), owner, occupied, n)
            counter += 1
    return board

def _place_linear_avoiding(board, size, struct_id, hp, decoy, owner, occupied, n) -> bool:
    """Coloca una estructura lineal evitando celdas ocupadas por otros jugadores."""
    for _ in range(1000):
        vertical = random.random() < 0.5
        x = random.randrange(n)
        y = random.randrange(n)
        if vertical:
            if y + size > n: continue
            cells = [(x, y + i) for i in range(size)]
        else:
            if x + size > n: continue
            cells = [(x + i, y) for i in range(size)]
        # Verificar que no colisione con el propio tablero ni con otros jugadores
        ok = True
        for (cx, cy) in cells:
            if not board[cy][cx].get('empty', True):
                ok = False; break
            if (cx, cy) in occupied:
                ok = False; break
        if not ok:
            continue
        for (cx, cy) in cells:
            board[cy][cx] = {'empty': False, 'structId': struct_id, 'hp': hp, 'decoy': decoy, 'owner': owner}
        return True
    return False

def find_player(state: RoomState, by_sid: Optional[str]=None, by_id: Optional[str]=None, by_name: Optional[str]=None) -> Optional[Player]:
    if by_sid:
        for p in state.players:
            if p.sid == by_sid: return p
    if by_id:
        for p in state.players:
            if p.id == by_id: return p
    if by_name:
        for p in state.players:
            if p.nombre == by_name: return p
    return None

def current_player(state: RoomState) -> Optional[Player]:
    if not state.players:
        return None
    idx = max(0, min(state.turn_idx, len(state.players)-1))
    return state.players[idx]

def struct_name_from_id(struct_id: str) -> str:
    key = (struct_id or '').split('-', 1)[0]
    return STRUCT_NAMES.get(key, key or 'Estructura')

def assign_powers(state: RoomState):
    state.powers = {}
    for p in state.players:
        k = random.randint(2, min(3, len(POWERS_POOL)))
        picks = random.sample(POWERS_POOL, k=k)
        state.powers[p.id] = picks

def emit_state_to_room(state: RoomState):
    """Emite a CADA jugador su estado; su tablero (myStructures) solo a él."""
    cp = current_player(state)
    for p in state.players:
        payload = {
            'players': [{'id': q.id, 'nombre': q.nombre, 'avatar': q.avatar, 'colorIndex': q.color_index} for q in state.players],
            'you': {'id': p.id, 'colorIndex': p.color_index},
            'turnoActualId': cp.id if cp else None,
            'turnoActualAvatar': cp.avatar if cp else 'granjero',
            'boardSize': state.board_size,
            'powers': state.powers.get(p.id, []),
            'myStructures': state.boards.get(p.id),
            'deadline': state.turn_deadline,
            'duration': TURN_DURATION,
        }
        emit('estado_juego', payload, room=p.sid)

def emit_turn_change(state: RoomState):
    cp = current_player(state)
    cp_avatar = cp.avatar if cp else 'granjero'
    emit('turno_siguiente', {
        'turnoActualId': cp.id if cp else None,
        'turnoActualAvatar': cp_avatar,
        'deadline': state.turn_deadline,
        'duration': TURN_DURATION,
    }, to=state.code)

def move_one_structure_random_step(board: List[List[dict]], key_prefix: str, only_undamaged: bool = False) -> bool:
    """Mueve una estructura (por prefix) 1 celda si es posible; si prefix='' toma cualquiera.
    Si only_undamaged=True, solo mueve estructuras que no hayan recibido ningún impacto.
    Retorna True si se movió, False si no fue posible."""
    ids = set()
    n = len(board)
    for y in range(n):
        for x in range(n):
            cell = board[y][x]
            if not cell.get('empty'):
                sid = cell.get('structId')
                if isinstance(sid, str) and (not key_prefix or sid.startswith(key_prefix)):
                    ids.add(sid)
    if not ids:
        return False

    # Filtrar estructuras sin impactos si se requiere
    if only_undamaged:
        undamaged = set()
        for sid in ids:
            has_hit = False
            for y in range(n):
                for x in range(n):
                    cell = board[y][x]
                    if cell.get('structId') == sid and cell.get('hit'):
                        has_hit = True
                        break
                if has_hit:
                    break
            if not has_hit:
                undamaged.add(sid)
        ids = undamaged
        if not ids:
            return False

    sid = random.choice(list(ids))
    cells = [(x,y) for y in range(n) for x in range(n) if board[y][x].get('structId') == sid]
    if not cells:
        return False
    dirs = [(0,-1),(0,1),(-1,0),(1,0)]
    random.shuffle(dirs)
    for dx,dy in dirs:
        ok = True
        for (x,y) in cells:
            nx, ny = x+dx, y+dy
            if nx < 0 or ny < 0 or nx >= n or ny >= n:
                ok = False; break
            if not (board[ny][nx].get('empty') or board[ny][nx].get('structId') == sid):
                ok = False; break
        if not ok:
            continue
        template = None
        for (x,y) in cells:
            if not template:
                template = board[y][x].copy()
            board[y][x] = {'empty': True}
        for (x,y) in cells:
            nx, ny = x+dx, y+dy
            board[ny][nx] = template.copy()
            board[ny][nx]['structId'] = sid
        return True
    return False

def move_beehives_for_room(state: RoomState):
    # Mueve estructuras 'colmena' 1 celda al final de la ronda global
    for p in state.players:
        if normalize_avatar(p.avatar) != 'apicultor':
            continue
        board = state.boards.get(p.id)
        if board:
            move_one_structure_random_step(board, 'colmena')

def start_turn_timer(state: RoomState):
    state.turn_deadline = time.time() + TURN_DURATION
    socketio.emit('turno_timer', {'deadline': state.turn_deadline, 'duration': TURN_DURATION}, to=state.code)

def schedule_turn_timeout(code, expected_turn_idx):
    """Schedule a check after TURN_DURATION seconds."""
    def _check():
        socketio.sleep(TURN_DURATION + 1)
        if code not in rooms_game:
            return
        state = rooms_game[code]
        if state.turn_idx != expected_turn_idx:
            return  # Turn already changed
        # Auto-skip
        cp = current_player(state)
        if cp and not cp.eliminated:
            socketio.emit('turno_auto_skip', {'playerName': cp.nombre}, to=code)
        advance_turn(state)
        save_game_state(code)
    socketio.start_background_task(_check)

def advance_turn(state: RoomState):
    # Maneja "doble_tiro"
    cp = current_player(state)
    if cp and cp.extra_shots > 0:
        cp.extra_shots -= 1
        return
    # Saltar jugadores eliminados
    for _ in range(len(state.players)):
        state.turn_idx = (state.turn_idx + 1) % max(1, len(state.players))
        next_p = state.players[state.turn_idx]
        if not next_p.eliminated:
            break
    # Si cerramos vuelta global:
    if state.turn_idx == 0:
        state.round_count += 1
        move_beehives_for_room(state)
        assign_powers(state)
        # Notifica tableros actualizados solo a cada dueño
        for p in state.players:
            emit('tablero_actualizado', {'myStructures': state.boards.get(p.id)}, room=p.sid)
    emit_turn_change(state)
    start_turn_timer(state)
    schedule_turn_timeout(state.code, state.turn_idx)

def is_player_defeated(board: List[List[dict]], owner_id: str) -> bool:
    """Revisa si todas las estructuras (no decoy) de un jugador han sido hundidas."""
    if not board:
        return True
    n = len(board)
    for y in range(n):
        for x in range(n):
            cell = board[y][x]
            if cell.get('empty', True):
                continue
            if cell.get('owner') != owner_id:
                continue
            if cell.get('decoy'):
                continue
            # Estructura real de este jugador con HP > 0
            if cell.get('hp', 0) > 0:
                return False
    return True

def check_eliminations_and_winner(state: RoomState):
    """Revisa si algún jugador perdió todas sus estructuras.
    Emite eventos de eliminación y/o victoria según corresponda."""
    newly_eliminated = []
    for p in state.players:
        if p.eliminated:
            continue
        board = state.boards.get(p.id)
        if is_player_defeated(board, p.id):
            p.eliminated = True
            newly_eliminated.append(p)

    # Emitir eliminaciones
    for p in newly_eliminated:
        emit('jugador_eliminado', {
            'playerId': p.id,
            'playerName': p.nombre,
        }, to=state.code)

    # Contar jugadores activos (no eliminados)
    active_players = [p for p in state.players if not p.eliminated]

    if len(active_players) == 1:
        winner = active_players[0]
        emit('juego_terminado', {
            'winnerId': winner.id,
            'winnerName': winner.nombre,
        }, to=state.code)
        return True  # juego terminado

    if len(active_players) == 0:
        # Caso borde: todos eliminados al mismo tiempo
        emit('juego_terminado', {
            'winnerId': None,
            'winnerName': 'Nadie',
        }, to=state.code)
        return True

    return False

@app.route("/")
def home():
    return render_template("index.html")

@app.route('/crear_sala', methods=['POST'])
def crear_sala():
    data = request.get_json()
    nombre = data['nombre']
    avatar = data['avatar'] or 'granjero'

    codigo = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    jugador = {'id': str(uuid.uuid4()), 'nombre': nombre, 'avatar': avatar, 'sid': None, 'anfitrion': True}

    rooms[codigo] = {
        'jugadores': [jugador],
        'juego_iniciado': False,
        'turno_actual': 0,
        'mensajes': [],
        'ganador': None,
        'comentarios_retrospectiva': []
    }

    # guarda en sesión para /sala
    session['codigo'] = codigo
    session['nombre'] = nombre
    session['anfitrion'] = True
    session['avatar'] = avatar
    session['player_id'] = jugador['id']

    save_room(codigo)
    return jsonify({'success': True, 'codigo': codigo})

@app.route('/unirse_sala', methods=['POST'])
def unirse_sala():
    data = request.get_json()
    nombre = data['nombre']
    avatar = data['avatar'] or 'granjero'
    codigo = data['codigo'].upper()

    if codigo not in rooms:
        return jsonify({'success': False, 'error': 'La sala no existe'}), 404
    
    room = rooms[codigo]
    if len(room['jugadores']) >= 10:
        return jsonify({'success': False, 'error': 'Sala llena'})
    if room['juego_iniciado']:
        return jsonify({'success': False, 'error': 'Juego ya iniciado'}) 
    for jugador in room['jugadores']:
        if jugador['nombre'] == nombre:
            return jsonify({'success': False, 'error': 'Nombre ya en uso'})
    

    # evita duplicados por nombre + (opcional) podrías usar un player_id real
    jugador = {'id': str(uuid.uuid4()), 'nombre': nombre, 'avatar': avatar, 'sid': None}
    rooms[codigo]['jugadores'].append(jugador)

    session['codigo'] = codigo
    session['nombre'] = nombre
    session['anfitrion'] = False
    session['avatar'] = avatar
    session['player_id'] = jugador['id']

    socketio.emit('jugadores_actualizados', {
        'codigo': codigo,
        'jugadores': room['jugadores'],
        'total': len(room['jugadores'])
    }, room=codigo)

    save_room(codigo)
    return jsonify({'success': True, 'codigo': codigo})

@app.route('/sala')
def sala():
    codigo = session.get('codigo')
    if not codigo or codigo not in rooms:
        return redirect(url_for('home'))   # <-- corrige 'inicio' -> 'home'

    room = rooms[codigo]
    return render_template('sala.html', jugadores=room['jugadores'], codigo=codigo,
                         puede_comenzar=len(room['jugadores']) >= 2)

@app.route('/iniciar_juego', methods=['POST'])
def iniciar_juego():
    print('Intentando iniciar juego...')
    codigo = session.get('codigo')
    nombre = session.get('nombre')
    if not codigo or codigo not in rooms:
        return jsonify({'success': False, 'error': 'Sala no válida'}), 404

    room = rooms[codigo]
    if room['jugadores'][0]['nombre'] != nombre:
        return jsonify({'success': False, 'error': 'Solo el anfitrión puede iniciar'})
    
    if len(room['jugadores']) < 2:
        return jsonify({'success': False, 'error': 'No hay suficientes jugadores'}), 400
    
    state = RoomState(code=codigo)
    for ci, j in enumerate(room['jugadores']):
        pid = j['id']
        p = Player(id=pid, sid=j.get('sid'), nombre=j['nombre'], avatar=j['avatar'], room=codigo, color_index=ci)
        state.players.append(p)
    
    max_cells = 0
    for p in state.players:
        cells = total_cells(augment_for_specials(p.avatar, loadout_for(p.avatar)))
        max_cells = max(max_cells, cells)
    state.board_size = calc_board_size(len(state.players), max_cells)

    for p in state.players:
        state.boards[p.id] = build_board_for(p.avatar, state.board_size, owner=p.id)

    # Resolver sobreposiciones entre estructuras de distintos jugadores
    resolve_all_overlaps(state.boards, state.board_size)

    state.turn_idx = 0
    state.round_count = 0
    assign_powers(state)
    rooms_game[codigo] = state

    room['turno_actual'] = 0
    room['juego_iniciado'] = True

    print(f'Juego iniciado en sala {codigo} por {nombre}')
    socketio.emit('juego_iniciado', room=codigo)
    start_turn_timer(state)
    schedule_turn_timeout(state.code, state.turn_idx)
    save_room(codigo)
    save_game_state(codigo)
    return jsonify({'success': True})

@app.route('/juego')
def juego():
    codigo = session.get('codigo')
    if not codigo or codigo not in rooms:
        return redirect(url_for('home'))
    if not rooms[codigo]['juego_iniciado']:
        return redirect(url_for('sala'))
    return render_template('juego.html')
    
    
# ---------- Socket.IO handlers ----------

# WebSocket Events
@socketio.on('connect')
def on_connect():
    codigo = session.get('codigo')
    if codigo:
        join_room(codigo)
        user_sessions[request.sid] = codigo
        print(f'Usuario conectado: {request.sid} a sala {codigo}')


@socketio.on('join_room')
def on_join_room(data):
    codigo = (data.get('room') or '').upper()
    nombre = (data.get('nombre') or 'Anónimo').strip()
    avatar = (data.get('avatar') or 'granjero').strip().lower()

    if not codigo or codigo not in rooms:
            emit('jugadores_actualizados', {'jugadores': []})
            return

    join_room(codigo)
    
    lista = rooms[codigo]['jugadores']
    found = next((j for j in lista if j.get('nombre') == nombre), None)
    if found:
        found['sid'] = request.sid
        found['avatar'] = avatar or found.get('avatar') or 'granjero'
    else:
        lista.append({'id': str(uuid.uuid4()), 'nombre': nombre, 'avatar': avatar, 'sid': request.sid})

    # Emite a TODOS en la sala
    emit('jugadores_actualizados', {'codigo': codigo, 'jugadores': lista}, to=codigo)

#Juego
@socketio.on('join_game')
def on_join_game(data):
    code = (data.get('room') or '').upper()
    nombre = (data.get('nombre') or 'Jugador').strip()
    avatar = (data.get('avatar') or 'granjero').strip()

    if not code or code not in rooms or not rooms[code]['juego_iniciado']:
        return

    # Crea RoomState si no existe (robusto ante reload tardío)
    if code not in rooms_game:
        state = RoomState(code=code)
        # Hidratamos desde lobby
        for ci, j in enumerate(rooms[code]['jugadores']):
            pid = j['id']
            state.players.append(Player(id=pid, sid=j.get('sid'), nombre=j['nombre'], avatar=j['avatar'], room=code, color_index=ci))
        # Tamaño mínimo por defecto
        max_cells = 0
        for p in state.players:
            cells = total_cells(augment_for_specials(p.avatar, loadout_for(p.avatar)))
            max_cells = max(max_cells, cells)
        state.board_size = calc_board_size(len(state.players), max_cells or 10)
        for p in state.players:
            state.boards[p.id] = build_board_for(p.avatar, state.board_size, owner=p.id)
        resolve_all_overlaps(state.boards, state.board_size)
        assign_powers(state)
        rooms_game[code] = state
        start_turn_timer(state)
        schedule_turn_timeout(state.code, state.turn_idx)

    state = rooms_game[code]
    join_room(code)

    # Vincula SID y/o crea jugador si no estuviera
    p = find_player(state, by_name=nombre) or find_player(state, by_sid=request.sid)
    if not p:
        pid = str(uuid.uuid4())
        ci = len(state.players)
        p = Player(id=pid, sid=request.sid, nombre=nombre, avatar=avatar, room=code, color_index=ci)
        state.players.append(p)
        # Generar tablero evitando posiciones ocupadas por otros jugadores
        occupied = set()
        for other_pid, other_board in state.boards.items():
            for oy in range(state.board_size):
                for ox in range(state.board_size):
                    if not other_board[oy][ox].get('empty', True):
                        occupied.add((ox, oy))
        state.boards[p.id] = build_board_avoiding(p.avatar, state.board_size, p.id, occupied)
    else:
        p.sid = request.sid
        p.avatar = avatar or p.avatar

    emit_state_to_room(state)

@socketio.on('disparo')
def on_disparo(data):
    code = (data.get('room') or '').upper()
    x = int(data.get('x', -1))
    y = int(data.get('y', -1))

    if code not in rooms_game:
        return
    state = rooms_game[code]
    shooter = find_player(state, by_sid=request.sid)
    if not shooter:
        nombre = session.get('nombre')
        if nombre:
            shooter = find_player(state, by_name=nombre)
            if shooter:
                shooter.sid = request.sid
    if not shooter:
        return

    # Valida turno
    if not current_player(state) or shooter.id != current_player(state).id:
        return

    # Jugador eliminado no puede disparar
    if shooter.eliminated:
        return

    n = state.board_size
    if x < 0 or y < 0 or x >= n or y >= n:
        return

    # Disparo broadcast: impacta la misma coordenada en TODOS los tableros enemigos
    results = []  # lista de resultados por cada jugador afectado
    for target in state.players:
        if target.id == shooter.id:
            continue  # no te disparas a ti mismo
        if target.eliminated:
            continue  # jugador ya eliminado, no se le dispara

        board = state.boards.get(target.id)
        if not board:
            continue

        cell = board[y][x]
        hit = False
        sunk = False
        structure_name = None
        decoy = False

        # Celda con miss ya confirmado: ignorar
        if cell.get('miss'):
            results.append({
                'targetId': target.id,
                'targetName': target.nombre,
                'hit': False, 'sunk': False, 'structureName': None,
                'decoy': False, 'already': True, 'hpLeft': 0,
            })
            continue

        # Celda con hit: solo ignorar si la estructura ya no tiene HP (ya hundida)
        if cell.get('hit'):
            hp = int(cell.get('hp', 0))
            if hp <= 0:
                results.append({
                    'targetId': target.id,
                    'targetName': target.nombre,
                    'hit': False, 'sunk': False, 'structureName': None,
                    'decoy': False, 'already': True, 'hpLeft': 0,
                })
                continue
            # Aún tiene HP: permitir otro impacto

        # No impactar las propias estructuras del shooter en tableros ajenos
        if not cell.get('empty', True) and cell.get('owner') == shooter.id:
            results.append({
                'targetId': target.id,
                'targetName': target.nombre,
                'hit': False, 'sunk': False, 'structureName': None,
                'decoy': False, 'already': True, 'hpLeft': 0,
            })
            continue

        if cell.get('empty', True):
            cell['miss'] = True
            cell['hit'] = False
            cell['shooterColor'] = shooter.color_index
            hit = False
        else:
            if cell.get('decoy'):
                decoy = True
                hit = True
                cell['hit'] = True
                cell['shooterColor'] = shooter.color_index
                structure_name = 'Trampa'
            else:
                hp = int(cell.get('hp', 1))
                if hp > 0:
                    cell['hp'] = max(0, hp - 1)
                cell['hit'] = True
                cell['miss'] = False
                cell['shooterColor'] = shooter.color_index
                hit = True

                sid = cell.get('structId')
                structure_name = struct_name_from_id(sid)

                # Revisar si toda la estructura fue hundida (todas las celdas con HP = 0)
                any_left = False
                for ry in range(n):
                    for rx in range(n):
                        c2 = board[ry][rx]
                        if c2.get('structId') == sid and c2.get('hp', 0) > 0:
                            any_left = True
                            break
                    if any_left:
                        break
                sunk = not any_left

        results.append({
            'targetId': target.id,
            'targetName': target.nombre,
            'hit': hit, 'sunk': sunk, 'structureName': structure_name,
            'decoy': decoy, 'already': False,
            'hpLeft': int(cell.get('hp', 0)) if hit and not decoy else 0,
        })

    # Marcar la celda (x, y) en los tableros de TODOS los jugadores para que vean el resultado
    any_hit = any(r['hit'] for r in results if not r.get('already'))
    max_hp_left = max((r.get('hpLeft', 0) for r in results if r.get('hit') and not r.get('already')), default=0)

    for p in state.players:
        if p.eliminated:
            continue
        board = state.boards.get(p.id)
        if not board:
            continue

        cell = board[y][x]
        is_own_structure = (not cell.get('empty', True) and cell.get('owner') == p.id)
        if is_own_structure:
            continue  # No marcar sobre las propias estructuras

        # Si este jugador fue target y recibió un hit real en SU estructura, no sobreescribir
        is_target_with_real_hit = any(
            r['targetId'] == p.id and r.get('hit') and not r.get('already')
            for r in results
        )
        if is_target_with_real_hit:
            continue

        # Para todos los demás (shooter, observadores, targets donde fue miss/already):
        # mostrar el resultado global del disparo
        if any_hit:
            cell['hit'] = True
            cell['miss'] = False
            cell['hp'] = max_hp_left
            cell['shooterColor'] = shooter.color_index
            cell['shot_fired'] = True
        elif not cell.get('shot_fired'):
            cell['miss'] = True
            cell['hit'] = False
            cell['hp'] = 0
            cell['shooterColor'] = shooter.color_index
            cell['shot_fired'] = True

    # Emitir resultado broadcast a toda la sala
    emit('resultado_disparo_broadcast', {
        'x': x, 'y': y,
        'shooterName': shooter.nombre,
        'shooterColor': shooter.color_index,
        'results': results,
    }, to=code)

    # Enviar tablero actualizado a TODOS los jugadores (cada uno recibe el suyo)
    for p in state.players:
        board = state.boards.get(p.id)
        if board:
            emit('tablero_actualizado', {'myStructures': board}, room=p.sid)

    # Verificar eliminaciones y posible ganador
    game_over = check_eliminations_and_winner(state)
    if not game_over:
        advance_turn(state)
    save_game_state(code)

@socketio.on('usar_poder')
def on_usar_poder(data):
    code = (data.get('room') or '').upper()
    x = int(data.get('x', -1))
    y = int(data.get('y', -1))
    power = data.get('power')
    target_id = data.get('targetId')

    if code not in rooms_game:
        return
    state = rooms_game[code]
    player = find_player(state, by_sid=request.sid)
    if not player:
        # Fallback: buscar por session
        nombre = session.get('nombre')
        if nombre:
            player = find_player(state, by_name=nombre)
            if player:
                player.sid = request.sid  # Actualizar SID
    if not player:
        return

    my_powers = state.powers.get(player.id, [])
    allowed = any(p['key'] == power for p in my_powers)
    if not allowed:
        emit('poder_resultado', {'ok': False, 'power': power, 'error': 'Poder no disponible'}, room=player.sid)
        return

    result: Dict[str, Any] = {'ok': True, 'power': power}

    if power == 'revelar_2x2':
        # Revelar área 2x2 en TODOS los tableros enemigos
        n = state.board_size
        reveals = []
        result['revealX'] = x
        result['revealY'] = y
        if 0 <= x < n and 0 <= y < n:
            for target in state.players:
                if target.id == player.id or target.eliminated:
                    continue
                board = state.boards.get(target.id)
                if not board:
                    continue
                area = []
                for yy in range(y, min(y + 2, n)):
                    row = []
                    for xx in range(x, min(x + 2, n)):
                        c = board[yy][xx]
                        has = not c.get('empty', True) and c.get('owner') != player.id
                        row.append({'has': has, 'decoy': bool(c.get('decoy')) if has else False})
                    area.append(row)
                reveals.append({'targetName': target.nombre, 'area': area})
        result['reveals'] = reveals

    elif power == 'mover_estructura':
        board = state.boards.get(player.id)
        moved = move_one_structure_random_step(board, key_prefix='', only_undamaged=True)
        result['moved'] = moved
        if moved:
            emit('tablero_actualizado', {'myStructures': board}, room=player.sid)

    elif power == 'senial':
        board = state.boards.get(player.id)
        n = len(board)
        empties = [(xx,yy) for yy in range(n) for xx in range(n) if board[yy][xx].get('empty', True)]
        if empties:
            xx, yy = random.choice(empties)
            board[yy][xx] = {'empty': False, 'structId': f"trampa-{uuid.uuid4().hex[:4]}", 'hp': 1, 'decoy': True}
            emit('tablero_actualizado', {'myStructures': board}, room=player.sid)

    elif power == 'doble_tiro':
        player.extra_shots = max(player.extra_shots, 1)

    elif power == 'escanear_linea':
        # Escanear fila Y columna en TODOS los tableros enemigos
        n = state.board_size
        row_scans = []
        col_scans = []
        if 0 <= y < n:
            for target in state.players:
                if target.id == player.id or target.eliminated:
                    continue
                board = state.boards.get(target.id)
                if not board:
                    continue
                has_row = any(
                    not board[y][xx].get('empty', True) and board[y][xx].get('owner') != player.id
                    for xx in range(n)
                )
                row_scans.append({'targetName': target.nombre, 'hasAny': has_row})
        if 0 <= x < n:
            for target in state.players:
                if target.id == player.id or target.eliminated:
                    continue
                board = state.boards.get(target.id)
                if not board:
                    continue
                has_col = any(
                    not board[yy][x].get('empty', True) and board[yy][x].get('owner') != player.id
                    for yy in range(n)
                )
                col_scans.append({'targetName': target.nombre, 'hasAny': has_col})
        result['row'] = y
        result['col'] = x
        result['rowScans'] = row_scans
        result['colScans'] = col_scans

    # Consume el poder
    state.powers[player.id] = [p for p in my_powers if p['key'] != power]
    emit('poder_resultado', result, room=player.sid)
    save_game_state(code)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if sid in user_sessions:
        codigo = user_sessions[sid]
        leave_room(codigo)
        del user_sessions[sid]
    # Don't remove player from game state - they might reconnect
    # Just leave the room for socket purposes

init_db()
load_all_state()

if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'true').lower() == 'true'
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=debug_mode)