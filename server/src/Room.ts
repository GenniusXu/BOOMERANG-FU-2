import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BOOMERANG_BOUNCE_DAMPING,
  BOOMERANG_BOUNCE_DRAG_ACCELERATION,
  BOOMERANG_BOUNCE_FLASH_MS,
  BOOMERANG_CATCH_DISTANCE,
  BOOMERANG_GROUND_SPEED,
  BOOMERANG_HAND_DISTANCE,
  BOOMERANG_HOMING_ACCELERATION,
  BOOMERANG_MIN_SPIN_SPEED,
  BOOMERANG_MAX_CHARGE_TIME_MS,
  BOOMERANG_MAX_THROW_SPEED,
  BOOMERANG_MIN_THROW_SPEED,
  BOOMERANG_PICKUP_DISTANCE,
  BOOMERANG_RADIUS,
  BOOMERANG_SPIN_SPEED_MULTIPLIER,
  MAP_COLS,
  MAP_GENERATION_ATTEMPTS,
  MAP_ROWS,
  MAX_PLAYERS,
  MIN_SPAWN_DISTANCE,
  PLAYER_ACCELERATION,
  PLAYER_CHARGING_BRAKE,
  PLAYER_DAMPING,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
  PLAYER_WALL_BOUNCE,
  PLAYER_WALL_CONTACT_EPSILON,
  ROUND_END_DELAY_MS,
  SCORE_TO_WIN,
  TILE_HEIGHT,
  TILE_WIDTH,
  WALL_CELL_COUNT,
  WALL_CORNER_RADIUS,
  WALL_HEIGHT,
  WALL_WIDTH
} from '../../shared/constants.js';
import type {
  BoomerangFlightPhase,
  BoomerangSnapshot,
  BoomerangState,
  GameSnapshot,
  ObstacleSnapshot,
  PlayerId,
  PlayerInput,
  PlayerSnapshot,
  RoomPhase,
  Vec2
} from '../../shared/protocol.js';

interface PlayerStateInternal {
  id: PlayerId;
  connected: boolean;
  nickname: string;
  position: Vec2;
  velocity: Vec2;
  aim: Vec2;
  alive: boolean;
  score: number;
  input: PlayerInput;
}

interface BoomerangEntity {
  ownerId: PlayerId;
  state: BoomerangState;
  flightPhase: BoomerangFlightPhase;
  position: Vec2;
  velocity: Vec2;
  chargeMs: number;
  chargeRatio: number;
  spinRadians: number;
  bounceFlashUntil: number;
}

interface MapState {
  blocked: boolean[][];
  obstacles: ObstacleSnapshot[];
}

interface SpawnPair {
  1: Vec2;
  2: Vec2;
}

interface Collision {
  normal: Vec2;
  position: Vec2;
}

export interface JoinResult {
  ok: boolean;
  playerId: PlayerId | null;
  roundStarted: boolean;
}

export interface LeaveResult {
  changed: boolean;
  roundEnded: boolean;
  winnerId: PlayerId | null;
}

const DEFAULT_INPUT: PlayerInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  throwPressed: false,
  aim: { x: 1, y: 0 },
  seq: 0
};

const EMPTY_MAP: MapState = {
  blocked: Array.from({ length: MAP_ROWS }, () => Array.from({ length: MAP_COLS }, () => false)),
  obstacles: []
};

export class Room {
  private readonly players = new Map<PlayerId, PlayerStateInternal>();
  private readonly boomerangs = new Map<PlayerId, BoomerangEntity>();
  private map: MapState = EMPTY_MAP;
  private tick = 0;
  private roundNumber = 0;
  private phase: RoomPhase = 'waiting';
  private roundWinnerId: PlayerId | null = null;
  private matchWinnerId: PlayerId | null = null;
  private phaseEndsAt: number | null = null;

  join(nickname = 'player'): JoinResult {
    const slot = this.nextOpenSlot();
    if (!slot) {
      return {
        ok: false,
        playerId: null,
        roundStarted: false
      };
    }

    const player = this.createPlayer(slot, nickname);
    this.players.set(slot, player);
    this.boomerangs.set(slot, this.createBoomerang(slot, player.position));

    const roundStarted = this.players.size === MAX_PLAYERS && this.phase === 'waiting';
    if (roundStarted) {
      this.startRound(false);
    }

    return {
      ok: true,
      playerId: slot,
      roundStarted
    };
  }

  leave(playerId: PlayerId | null): LeaveResult {
    if (!playerId || !this.players.has(playerId)) {
      return {
        changed: false,
        roundEnded: false,
        winnerId: null
      };
    }

    const wasPlaying = this.phase === 'playing';
    this.players.delete(playerId);
    this.boomerangs.delete(playerId);

    const remaining = [...this.players.keys()];
    const winnerId = wasPlaying ? (remaining[0] ?? null) : null;
    this.phase = 'waiting';
    this.roundWinnerId = winnerId;
    this.matchWinnerId = null;
    this.phaseEndsAt = null;
    this.resetLivePlayersForWaiting();

    return {
      changed: true,
      roundEnded: wasPlaying,
      winnerId
    };
  }

  setInput(playerId: PlayerId | null, input: PlayerInput): void {
    if (!playerId || this.phase === 'matchEnded') {
      return;
    }

    const player = this.players.get(playerId);
    if (!player || input.seq < player.input.seq) {
      return;
    }

    player.input = {
      up: Boolean(input.up),
      down: Boolean(input.down),
      left: Boolean(input.left),
      right: Boolean(input.right),
      throwPressed: Boolean(input.throwPressed),
      aim: normalize(input.aim, player.aim),
      seq: input.seq
    };
    player.aim = player.input.aim;
  }

  replay(): void {
    for (const player of this.players.values()) {
      player.score = 0;
    }

    this.matchWinnerId = null;
    this.roundWinnerId = null;
    this.phaseEndsAt = null;

    if (this.players.size === MAX_PLAYERS) {
      this.roundNumber = 0;
      this.startRound(false);
    } else {
      this.phase = 'waiting';
      this.resetLivePlayersForWaiting();
    }
  }

  step(dtSeconds: number): void {
    this.tick += 1;

    if (this.players.size < MAX_PLAYERS) {
      this.phase = 'waiting';
      return;
    }

    if (this.phase === 'roundEnded' && this.phaseEndsAt !== null && Date.now() >= this.phaseEndsAt) {
      this.startRound(false);
      return;
    }

    if (this.phase !== 'playing') {
      return;
    }

    const now = Date.now();
    this.updatePlayers(dtSeconds);
    this.updateBoomerangs(dtSeconds, now);
  }

  snapshot(): GameSnapshot {
    return {
      tick: this.tick,
      serverTime: Date.now(),
      phase: this.phase,
      maxPlayers: MAX_PLAYERS,
      roundNumber: this.roundNumber,
      roundWinnerId: this.roundWinnerId,
      matchWinnerId: this.matchWinnerId,
      phaseEndsAt: this.phaseEndsAt,
      scoreToWin: SCORE_TO_WIN,
      arena: {
        width: ARENA_WIDTH,
        height: ARENA_HEIGHT
      },
      players: [...this.players.values()].map((player) => this.toPlayerSnapshot(player)),
      obstacles: this.map.obstacles,
      boomerangs: [...this.boomerangs.values()].map((boomerang) => this.toBoomerangSnapshot(boomerang))
    };
  }

  playerCount(): number {
    return this.players.size;
  }

  private startRound(resetScores: boolean): void {
    if (resetScores) {
      for (const player of this.players.values()) {
        player.score = 0;
      }
    }

    this.roundNumber += 1;
    this.phase = 'playing';
    this.roundWinnerId = null;
    this.matchWinnerId = null;
    this.phaseEndsAt = null;
    this.map = generateConnectedMap();

    const spawns = chooseSpawnPair(this.map);
    for (const id of [1, 2] as PlayerId[]) {
      const player = this.players.get(id);
      if (!player) {
        continue;
      }

      const aim = id === 1 ? { x: 1, y: 0 } : { x: -1, y: 0 };
      player.position = { ...spawns[id] };
      player.velocity = { x: 0, y: 0 };
      player.aim = aim;
      player.alive = true;
      player.input = {
        ...DEFAULT_INPUT,
        aim,
        seq: player.input.seq
      };
      this.boomerangs.set(id, this.createBoomerang(id, player.position));
    }
  }

  private updatePlayers(dtSeconds: number): void {
    for (const player of this.players.values()) {
      if (!player.alive) {
        continue;
      }

      const boomerang = this.boomerangs.get(player.id);
      if (boomerang?.state === 'held' && player.input.throwPressed) {
        this.startCharging(player, boomerang);
      }

      const charging = boomerang?.state === 'charging';
      const desired = {
        x: Number(player.input.right) - Number(player.input.left),
        y: Number(player.input.down) - Number(player.input.up)
      };
      const hasMove = desired.x !== 0 || desired.y !== 0;
      const direction = normalize(desired, { x: 0, y: 0 });

      if (hasMove && !charging) {
        player.velocity.x += direction.x * PLAYER_ACCELERATION * dtSeconds;
        player.velocity.y += direction.y * PLAYER_ACCELERATION * dtSeconds;
      }

      const dampingStrength = charging ? PLAYER_CHARGING_BRAKE : PLAYER_DAMPING;
      const damping = Math.max(0, 1 - dampingStrength * dtSeconds);
      player.velocity.x *= damping;
      player.velocity.y *= damping;

      const speed = length(player.velocity);
      if (speed > PLAYER_MAX_SPEED) {
        const scale = PLAYER_MAX_SPEED / speed;
        player.velocity.x *= scale;
        player.velocity.y *= scale;
      }

      player.velocity = this.constrainPlayerVelocityAtContacts(player.position, player.velocity);
      this.movePlayerWithCollisions(player, dtSeconds);
      this.updatePlayerBoomerangControl(player, dtSeconds);
    }
  }

  private updatePlayerBoomerangControl(player: PlayerStateInternal, dtSeconds: number): void {
    const boomerang = this.boomerangs.get(player.id);
    if (!boomerang) {
      return;
    }

    if (boomerang.state === 'held') {
      this.syncBoomerangToHand(player, boomerang);
      return;
    }

    if (boomerang.state === 'charging') {
      boomerang.chargeMs = Math.min(BOOMERANG_MAX_CHARGE_TIME_MS, boomerang.chargeMs + dtSeconds * 1000);
      boomerang.chargeRatio = boomerang.chargeMs / BOOMERANG_MAX_CHARGE_TIME_MS;
      this.syncBoomerangToHand(player, boomerang);

      if (!player.input.throwPressed) {
        this.throwBoomerang(player, boomerang);
      }
      return;
    }

    if (boomerang.state === 'grounded' && distance(boomerang.position, player.position) <= BOOMERANG_PICKUP_DISTANCE) {
      this.setBoomerangHeld(player, boomerang);
    }
  }

  private updateBoomerangs(dtSeconds: number, now: number): void {
    for (const boomerang of this.boomerangs.values()) {
      if (boomerang.state !== 'flying_returning' && boomerang.state !== 'flying_bouncing') {
        continue;
      }

      const owner = this.players.get(boomerang.ownerId);
      if (!owner) {
        continue;
      }

      if (boomerang.state === 'flying_returning') {
        this.updateReturningBoomerang(boomerang, owner, dtSeconds);
      } else {
        this.updateBouncingBoomerang(boomerang, dtSeconds);
      }

      if (boomerang.state !== 'flying_returning' && boomerang.state !== 'flying_bouncing') {
        continue;
      }

      boomerang.position.x += boomerang.velocity.x * dtSeconds;
      boomerang.position.y += boomerang.velocity.y * dtSeconds;
      boomerang.spinRadians += (BOOMERANG_MIN_SPIN_SPEED + length(boomerang.velocity) * BOOMERANG_SPIN_SPEED_MULTIPLIER) * dtSeconds;

      const collision = this.resolveBoomerangCollision(boomerang.position);
      if (collision) {
        boomerang.position = collision.position;
        boomerang.velocity = scale(reflect(boomerang.velocity, collision.normal), BOOMERANG_BOUNCE_DAMPING);
        boomerang.state = 'flying_bouncing';
        boomerang.flightPhase = 'bouncing';
        boomerang.bounceFlashUntil = now + BOOMERANG_BOUNCE_FLASH_MS;
      }

      if (boomerang.state === 'flying_bouncing' && length(boomerang.velocity) <= BOOMERANG_GROUND_SPEED) {
        this.groundBoomerang(boomerang);
        continue;
      }

      if (owner.alive && distance(boomerang.position, owner.position) <= BOOMERANG_CATCH_DISTANCE) {
        this.setBoomerangHeld(owner, boomerang);
        continue;
      }

      const target = this.players.get(otherPlayerId(boomerang.ownerId));
      if (target?.alive && distance(boomerang.position, target.position) <= PLAYER_RADIUS + BOOMERANG_RADIUS) {
        this.handleKill(boomerang.ownerId, target.id);
      }
    }
  }

  private updateReturningBoomerang(boomerang: BoomerangEntity, owner: PlayerStateInternal, dtSeconds: number): void {
    const toOwner = normalize(
      {
        x: owner.position.x - boomerang.position.x,
        y: owner.position.y - boomerang.position.y
      },
      { x: 0, y: 0 }
    );

    boomerang.velocity.x += toOwner.x * BOOMERANG_HOMING_ACCELERATION * dtSeconds;
    boomerang.velocity.y += toOwner.y * BOOMERANG_HOMING_ACCELERATION * dtSeconds;
  }

  private updateBouncingBoomerang(boomerang: BoomerangEntity, dtSeconds: number): void {
    const speed = length(boomerang.velocity);
    if (speed <= BOOMERANG_GROUND_SPEED) {
      this.groundBoomerang(boomerang);
      return;
    }

    const dragAmount = BOOMERANG_BOUNCE_DRAG_ACCELERATION * dtSeconds;
    if (dragAmount >= speed) {
      this.groundBoomerang(boomerang);
      return;
    }

    const dragDirection = normalize(boomerang.velocity, { x: 0, y: 0 });
    boomerang.velocity.x -= dragDirection.x * dragAmount;
    boomerang.velocity.y -= dragDirection.y * dragAmount;
  }

  private startCharging(player: PlayerStateInternal, boomerang: BoomerangEntity): void {
    boomerang.state = 'charging';
    boomerang.flightPhase = 'held';
    boomerang.chargeMs = 0;
    boomerang.chargeRatio = 0;
    boomerang.velocity = { x: 0, y: 0 };
    this.syncBoomerangToHand(player, boomerang);
  }

  private throwBoomerang(player: PlayerStateInternal, boomerang: BoomerangEntity): void {
    const ratio = clamp(boomerang.chargeMs / BOOMERANG_MAX_CHARGE_TIME_MS, 0, 1);
    const speed = lerp(BOOMERANG_MIN_THROW_SPEED, BOOMERANG_MAX_THROW_SPEED, ratio);
    const aim = normalize(player.aim, player.id === 1 ? { x: 1, y: 0 } : { x: -1, y: 0 });

    boomerang.state = 'flying_returning';
    boomerang.flightPhase = 'homing';
    boomerang.chargeRatio = ratio;
    boomerang.position = {
      x: player.position.x + aim.x * BOOMERANG_HAND_DISTANCE,
      y: player.position.y + aim.y * BOOMERANG_HAND_DISTANCE
    };
    boomerang.velocity = {
      x: aim.x * speed,
      y: aim.y * speed
    };
  }

  private syncBoomerangToHand(player: PlayerStateInternal, boomerang: BoomerangEntity): void {
    boomerang.position = {
      x: player.position.x + player.aim.x * BOOMERANG_HAND_DISTANCE,
      y: player.position.y + player.aim.y * BOOMERANG_HAND_DISTANCE
    };
    boomerang.velocity = { x: 0, y: 0 };
  }

  private setBoomerangHeld(player: PlayerStateInternal, boomerang: BoomerangEntity): void {
    boomerang.state = 'held';
    boomerang.flightPhase = 'held';
    boomerang.chargeMs = 0;
    boomerang.chargeRatio = 0;
    boomerang.velocity = { x: 0, y: 0 };
    this.syncBoomerangToHand(player, boomerang);
  }

  private groundBoomerang(boomerang: BoomerangEntity): void {
    boomerang.state = 'grounded';
    boomerang.flightPhase = 'grounded';
    boomerang.velocity = { x: 0, y: 0 };
  }

  private handleKill(attackerId: PlayerId, victimId: PlayerId): void {
    const attacker = this.players.get(attackerId);
    const victim = this.players.get(victimId);
    if (!attacker || !victim || this.phase !== 'playing') {
      return;
    }

    attacker.score += 1;
    victim.alive = false;
    victim.velocity = { x: 0, y: 0 };
    this.resetBoomerang(attackerId);
    this.resetBoomerang(victimId);

    this.roundWinnerId = attackerId;
    if (attacker.score >= SCORE_TO_WIN) {
      this.phase = 'matchEnded';
      this.matchWinnerId = attackerId;
      this.phaseEndsAt = null;
      return;
    }

    this.phase = 'roundEnded';
    this.phaseEndsAt = Date.now() + ROUND_END_DELAY_MS;
  }

  private constrainPlayerVelocityAtContacts(position: Vec2, velocity: Vec2): Vec2 {
    let constrained = { ...velocity };

    for (const normal of this.playerContactNormals(position)) {
      constrained = removeInwardVelocity(constrained, normal);
    }

    return constrained;
  }

  private playerContactNormals(position: Vec2): Vec2[] {
    const normals: Vec2[] = [];

    if (position.x <= PLAYER_RADIUS + PLAYER_WALL_CONTACT_EPSILON) {
      normals.push({ x: 1, y: 0 });
    }
    if (position.x >= ARENA_WIDTH - PLAYER_RADIUS - PLAYER_WALL_CONTACT_EPSILON) {
      normals.push({ x: -1, y: 0 });
    }
    if (position.y <= PLAYER_RADIUS + PLAYER_WALL_CONTACT_EPSILON) {
      normals.push({ x: 0, y: 1 });
    }
    if (position.y >= ARENA_HEIGHT - PLAYER_RADIUS - PLAYER_WALL_CONTACT_EPSILON) {
      normals.push({ x: 0, y: -1 });
    }

    for (const obstacle of this.map.obstacles) {
      const normal = circleRoundedRectContactNormal(
        position,
        PLAYER_RADIUS,
        obstacle,
        WALL_CORNER_RADIUS,
        PLAYER_WALL_CONTACT_EPSILON
      );
      if (normal) {
        normals.push(normal);
      }
    }

    return normals;
  }

  private movePlayerWithCollisions(player: PlayerStateInternal, dtSeconds: number): void {
    const nextX = {
      x: player.position.x + player.velocity.x * dtSeconds,
      y: player.position.y
    };
    const resolvedX = this.resolvePlayerAxis(nextX, 'x', player.velocity.x);
    player.position.x = resolvedX.position.x;
    player.position.y = resolvedX.position.y;
    if (resolvedX.normal) {
      player.velocity = bounceOffWall(player.velocity, resolvedX.normal, PLAYER_WALL_BOUNCE);
    }

    const nextY = {
      x: player.position.x,
      y: player.position.y + player.velocity.y * dtSeconds
    };
    const resolvedY = this.resolvePlayerAxis(nextY, 'y', player.velocity.y);
    player.position.x = resolvedY.position.x;
    player.position.y = resolvedY.position.y;
    if (resolvedY.normal) {
      player.velocity = bounceOffWall(player.velocity, resolvedY.normal, PLAYER_WALL_BOUNCE);
    }
  }

  private resolvePlayerAxis(position: Vec2, axis: 'x' | 'y', velocity: number): { position: Vec2; normal: Vec2 | null } {
    const resolved = { ...position };
    let normal: Vec2 | null = null;

    if (axis === 'x') {
      if (resolved.x < PLAYER_RADIUS) {
        resolved.x = PLAYER_RADIUS;
        normal = { x: 1, y: 0 };
      } else if (resolved.x > ARENA_WIDTH - PLAYER_RADIUS) {
        resolved.x = ARENA_WIDTH - PLAYER_RADIUS;
        normal = { x: -1, y: 0 };
      }
    } else if (resolved.y < PLAYER_RADIUS) {
      resolved.y = PLAYER_RADIUS;
      normal = { x: 0, y: 1 };
    } else if (resolved.y > ARENA_HEIGHT - PLAYER_RADIUS) {
      resolved.y = ARENA_HEIGHT - PLAYER_RADIUS;
      normal = { x: 0, y: -1 };
    }

    for (const obstacle of this.map.obstacles) {
      const collision = circleRoundedRectCollision(resolved, PLAYER_RADIUS, obstacle, WALL_CORNER_RADIUS);
      if (!collision) {
        continue;
      }

      normal = collision.normal;
      resolved.x = collision.position.x;
      resolved.y = collision.position.y;
    }

    resolved.x = clamp(resolved.x, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
    resolved.y = clamp(resolved.y, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
    return { position: resolved, normal };
  }

  private resolveBoomerangCollision(position: Vec2): Collision | null {
    const wallCollision = arenaCollision(position, BOOMERANG_RADIUS);
    if (wallCollision) {
      return wallCollision;
    }

    for (const obstacle of this.map.obstacles) {
      const collision = circleRoundedRectCollision(position, BOOMERANG_RADIUS, obstacle, WALL_CORNER_RADIUS);
      if (collision) {
        return collision;
      }
    }

    return null;
  }

  private resetBoomerang(ownerId: PlayerId): void {
    const owner = this.players.get(ownerId);
    if (!owner) {
      return;
    }

    this.boomerangs.set(ownerId, this.createBoomerang(ownerId, owner.position));
  }

  private resetLivePlayersForWaiting(): void {
    for (const player of this.players.values()) {
      player.alive = true;
      player.velocity = { x: 0, y: 0 };
      player.input = {
        ...DEFAULT_INPUT,
        seq: player.input.seq
      };
      this.resetBoomerang(player.id);
    }
  }

  private nextOpenSlot(): PlayerId | null {
    if (!this.players.has(1)) {
      return 1;
    }
    if (!this.players.has(2)) {
      return 2;
    }
    return null;
  }

  private createPlayer(id: PlayerId, nickname: string): PlayerStateInternal {
    const position = id === 1 ? { x: 180, y: ARENA_HEIGHT / 2 } : { x: ARENA_WIDTH - 180, y: ARENA_HEIGHT / 2 };
    const aim = id === 1 ? { x: 1, y: 0 } : { x: -1, y: 0 };

    return {
      id,
      connected: true,
      nickname,
      position,
      velocity: { x: 0, y: 0 },
      aim,
      alive: true,
      score: 0,
      input: {
        ...DEFAULT_INPUT,
        aim
      }
    };
  }

  private createBoomerang(ownerId: PlayerId, ownerPosition: Vec2): BoomerangEntity {
    const aim = ownerId === 1 ? { x: 1, y: 0 } : { x: -1, y: 0 };

    return {
      ownerId,
      state: 'held',
      flightPhase: 'held',
      position: {
        x: ownerPosition.x + aim.x * BOOMERANG_HAND_DISTANCE,
        y: ownerPosition.y + aim.y * BOOMERANG_HAND_DISTANCE
      },
      velocity: { x: 0, y: 0 },
      chargeMs: 0,
      chargeRatio: 0,
      spinRadians: 0,
      bounceFlashUntil: 0
    };
  }

  private toPlayerSnapshot(player: PlayerStateInternal): PlayerSnapshot {
    const boomerang = this.boomerangs.get(player.id);

    return {
      id: player.id,
      connected: player.connected,
      nickname: player.nickname,
      position: { ...player.position },
      velocity: { ...player.velocity },
      aim: { ...player.aim },
      alive: player.alive,
      score: player.score,
      hasBoomerang: boomerang?.state === 'held' || boomerang?.state === 'charging',
      boomerangState: boomerang?.state ?? 'held',
      lastInputSeq: player.input.seq
    };
  }

  private toBoomerangSnapshot(boomerang: BoomerangEntity): BoomerangSnapshot {
    return {
      ownerId: boomerang.ownerId,
      state: boomerang.state,
      flightPhase: boomerang.flightPhase,
      returning: boomerang.state === 'flying_returning',
      active: boomerang.state === 'flying_returning' || boomerang.state === 'flying_bouncing',
      grounded: boomerang.state === 'grounded',
      position: { ...boomerang.position },
      velocity: { ...boomerang.velocity },
      chargeRatio: boomerang.chargeRatio,
      spinRadians: boomerang.spinRadians,
      bounceFlashUntil: boomerang.bounceFlashUntil
    };
  }
}

function generateConnectedMap(): MapState {
  let best = EMPTY_MAP;

  for (let attempt = 0; attempt < MAP_GENERATION_ATTEMPTS; attempt += 1) {
    const blocked = Array.from({ length: MAP_ROWS }, () => Array.from({ length: MAP_COLS }, () => false));
    let placed = 0;
    let guard = 0;

    while (placed < WALL_CELL_COUNT && guard < WALL_CELL_COUNT * 30) {
      guard += 1;
      const x = randomInt(1, MAP_COLS - 2);
      const y = randomInt(1, MAP_ROWS - 2);

      if (blocked[y][x] || isReservedSpawnArea(x, y)) {
        continue;
      }

      blocked[y][x] = true;
      if (!allOpenCellsConnected(blocked)) {
        blocked[y][x] = false;
        continue;
      }

      placed += 1;
    }

    const map = {
      blocked,
      obstacles: blockedToObstacles(blocked)
    };
    best = map;

    if (placed >= WALL_CELL_COUNT) {
      return map;
    }
  }

  return best;
}

function chooseSpawnPair(map: MapState): SpawnPair {
  const candidates = openCellCenters(map.blocked);
  let bestPair: SpawnPair = {
    1: { x: 180, y: ARENA_HEIGHT / 2 },
    2: { x: ARENA_WIDTH - 180, y: ARENA_HEIGHT / 2 }
  };
  let bestDistance = 0;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const a = candidates[randomInt(0, candidates.length - 1)];
    const b = candidates[randomInt(0, candidates.length - 1)];
    const d = distance(a, b);

    if (d > bestDistance) {
      bestDistance = d;
      bestPair = { 1: a, 2: b };
    }

    if (d >= MIN_SPAWN_DISTANCE) {
      return { 1: a, 2: b };
    }
  }

  return bestPair;
}

function allOpenCellsConnected(blocked: boolean[][]): boolean {
  let start: { x: number; y: number } | null = null;
  let openCount = 0;

  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      if (!blocked[y][x]) {
        openCount += 1;
        start ??= { x, y };
      }
    }
  }

  if (!start) {
    return false;
  }

  const visited = Array.from({ length: MAP_ROWS }, () => Array.from({ length: MAP_COLS }, () => false));
  const queue = [start];
  visited[start.y][start.x] = true;
  let reached = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    reached += 1;
    for (const next of neighbors(current.x, current.y)) {
      if (visited[next.y][next.x] || blocked[next.y][next.x]) {
        continue;
      }

      visited[next.y][next.x] = true;
      queue.push(next);
    }
  }

  return reached === openCount;
}

function neighbors(x: number, y: number): Array<{ x: number; y: number }> {
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 }
  ].filter((cell) => cell.x >= 0 && cell.x < MAP_COLS && cell.y >= 0 && cell.y < MAP_ROWS);
}

function blockedToObstacles(blocked: boolean[][]): ObstacleSnapshot[] {
  const obstacles: ObstacleSnapshot[] = [];

  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      if (!blocked[y][x]) {
        continue;
      }

      obstacles.push({
        id: `wall-${x}-${y}`,
        x: x * TILE_WIDTH + (TILE_WIDTH - WALL_WIDTH) / 2,
        y: y * TILE_HEIGHT + (TILE_HEIGHT - WALL_HEIGHT) / 2,
        width: WALL_WIDTH,
        height: WALL_HEIGHT
      });
    }
  }

  return obstacles;
}

function openCellCenters(blocked: boolean[][]): Vec2[] {
  const cells: Vec2[] = [];

  for (let y = 0; y < MAP_ROWS; y += 1) {
    for (let x = 0; x < MAP_COLS; x += 1) {
      if (blocked[y][x]) {
        continue;
      }

      cells.push({
        x: x * TILE_WIDTH + TILE_WIDTH / 2,
        y: y * TILE_HEIGHT + TILE_HEIGHT / 2
      });
    }
  }

  return cells;
}

function isReservedSpawnArea(x: number, y: number): boolean {
  const inLeftSpawnZone = x <= 2 && y >= 4 && y <= 7;
  const inRightSpawnZone = x >= MAP_COLS - 3 && y >= 4 && y <= 7;
  return inLeftSpawnZone || inRightSpawnZone;
}

function arenaCollision(position: Vec2, radius: number): Collision | null {
  if (position.x < radius) {
    return {
      normal: { x: 1, y: 0 },
      position: { x: radius, y: position.y }
    };
  }
  if (position.x > ARENA_WIDTH - radius) {
    return {
      normal: { x: -1, y: 0 },
      position: { x: ARENA_WIDTH - radius, y: position.y }
    };
  }
  if (position.y < radius) {
    return {
      normal: { x: 0, y: 1 },
      position: { x: position.x, y: radius }
    };
  }
  if (position.y > ARENA_HEIGHT - radius) {
    return {
      normal: { x: 0, y: -1 },
      position: { x: position.x, y: ARENA_HEIGHT - radius }
    };
  }

  return null;
}

function circleRoundedRectCollision(center: Vec2, radius: number, rect: ObstacleSnapshot, cornerRadius: number): Collision | null {
  const distanceToWall = roundedRectSignedDistance(center, rect, cornerRadius);
  if (distanceToWall > radius) {
    return null;
  }

  const normal = roundedRectNormal(center, rect, cornerRadius);
  const pushDistance = radius - distanceToWall + 0.01;
  return {
    normal,
    position: {
      x: center.x + normal.x * pushDistance,
      y: center.y + normal.y * pushDistance
    }
  };
}

function circleRoundedRectContactNormal(
  center: Vec2,
  radius: number,
  rect: ObstacleSnapshot,
  cornerRadius: number,
  tolerance: number
): Vec2 | null {
  const distanceToWall = roundedRectSignedDistance(center, rect, cornerRadius);
  if (distanceToWall > radius + tolerance) {
    return null;
  }

  return roundedRectNormal(center, rect, cornerRadius);
}

function roundedRectSignedDistance(point: Vec2, rect: ObstacleSnapshot, cornerRadius: number): number {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const radius = clamp(cornerRadius, 0, Math.min(halfWidth, halfHeight));
  const innerHalfWidth = halfWidth - radius;
  const innerHalfHeight = halfHeight - radius;
  const localX = point.x - (rect.x + halfWidth);
  const localY = point.y - (rect.y + halfHeight);
  const qx = Math.abs(localX) - innerHalfWidth;
  const qy = Math.abs(localY) - innerHalfHeight;
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(qx, qy), 0) - radius;
}

function roundedRectNormal(point: Vec2, rect: ObstacleSnapshot, cornerRadius: number): Vec2 {
  const epsilon = 0.05;
  const dx =
    roundedRectSignedDistance({ x: point.x + epsilon, y: point.y }, rect, cornerRadius) -
    roundedRectSignedDistance({ x: point.x - epsilon, y: point.y }, rect, cornerRadius);
  const dy =
    roundedRectSignedDistance({ x: point.x, y: point.y + epsilon }, rect, cornerRadius) -
    roundedRectSignedDistance({ x: point.x, y: point.y - epsilon }, rect, cornerRadius);

  return normalize({ x: dx, y: dy }, nearestRectSideNormal(point, rect));
}

function nearestRectSideNormal(point: Vec2, rect: ObstacleSnapshot): Vec2 {
  const left = Math.abs(point.x - rect.x);
  const right = Math.abs(rect.x + rect.width - point.x);
  const top = Math.abs(point.y - rect.y);
  const bottom = Math.abs(rect.y + rect.height - point.y);
  const min = Math.min(left, right, top, bottom);

  if (min === left) {
    return { x: -1, y: 0 };
  }
  if (min === right) {
    return { x: 1, y: 0 };
  }
  if (min === top) {
    return { x: 0, y: -1 };
  }
  return { x: 0, y: 1 };
}

function reflect(vector: Vec2, normal: Vec2): Vec2 {
  const dot = vector.x * normal.x + vector.y * normal.y;
  return {
    x: vector.x - 2 * dot * normal.x,
    y: vector.y - 2 * dot * normal.y
  };
}

function bounceOffWall(velocity: Vec2, normal: Vec2, restitution: number): Vec2 {
  const dot = velocity.x * normal.x + velocity.y * normal.y;
  if (dot >= 0) {
    return velocity;
  }

  return {
    x: velocity.x - (1 + restitution) * dot * normal.x,
    y: velocity.y - (1 + restitution) * dot * normal.y
  };
}

function removeInwardVelocity(velocity: Vec2, normal: Vec2): Vec2 {
  const dot = velocity.x * normal.x + velocity.y * normal.y;
  if (dot >= 0) {
    return velocity;
  }

  return {
    x: velocity.x - dot * normal.x,
    y: velocity.y - dot * normal.y
  };
}

function normalize(vector: Vec2, fallback: Vec2): Vec2 {
  const vectorLength = length(vector);
  if (vectorLength < 0.001) {
    return fallback;
  }

  return {
    x: vector.x / vectorLength,
    y: vector.y / vectorLength
  };
}

function scale(vector: Vec2, amount: number): Vec2 {
  return {
    x: vector.x * amount,
    y: vector.y * amount
  };
}

function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y);
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * clamp(t, 0, 1);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function otherPlayerId(id: PlayerId): PlayerId {
  return id === 1 ? 2 : 1;
}
