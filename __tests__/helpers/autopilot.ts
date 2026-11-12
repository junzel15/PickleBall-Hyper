// Test autopilot: plays the game through the same inputs a person uses
// (the stick and the shot buttons), never by changing game state directly.
import type { Game } from '../../src/game/engine';

type Shot = 'drive' | 'dink' | 'lob' | 'smash';

export interface Pilot {
  /** Call once per simulation tick. */
  tick(dt: number): void;
  shotsTapped: Record<Shot, number>;
  hyperPressed: number;
}

/**
 * @param mode 'play' returns every ball; 'serve-only' serves but never returns (to end a match quickly);
 * @param shots the shot types to cycle through.
 */
export function makePilot(game: Game, opts: { mode?: () => 'play' | 'serve-only'; shots?: Shot[]; hyper?: boolean; tapEarly?: boolean } = {}): Pilot {
  const shots = opts.shots ?? ['drive', 'lob', 'dink', 'drive', 'smash'];
  let shotIdx = 0;
  let tappedFor = -1;   // the rally shot count we already tapped for
  let serveWait = 0;
  const pilot: Pilot = {
    shotsTapped: { drive: 0, dink: 0, lob: 0, smash: 0 },
    hyperPressed: 0,
    tick(dt: number) {
      const d = game.debug();
      const mode = opts.mode ? opts.mode() : 'play';
      if (d.state === 'serve') {
        tappedFor = -1;
        game.testInput({ dx: 0, dy: 0 });
        if (d.serverIsMe) {
          serveWait += dt;
          if (serveWait > 0.6) { serveWait = 0; game.testInput({ tap: 'drive' }); pilot.shotsTapped.drive++; }
        } else serveWait = 0;
        return;
      }
      serveWait = 0;
      if (opts.hyper && d.energy >= 100 && d.hyperT <= 0 && (d.state === 'rally' || d.state === 'point')) {
        game.testInput({ hyper: true });
        pilot.hyperPressed++;
      }
      if (d.state !== 'rally' || mode === 'serve-only') { game.testInput({ dx: 0, dy: 0 }); return; }
      const incoming = d.lastHitter === 'ai' && !d.held;
      // stand a little behind where the ball will cross our line, let it bounce first
      const homeY = 40;
      // doubles: the partner nearer the ball takes it, the other holds their half
      const mate = d.athletes.find(a => a.team === 'player' && Math.abs(a.x - d.px) + Math.abs(a.y - d.py) > 0.01);
      let tx = mate ? (d.px < mate.x ? 5 : 15) : 10;
      if (incoming && d.bvy > 1) {
        const t = Math.max(0, (homeY - 1 - d.by) / d.bvy);
        const bx = d.bx + d.bvx * Math.min(t, 1.5) - 1.0;
        if (!mate || Math.abs(bx - d.px) <= Math.abs(bx - mate.x)) tx = bx;
      }
      const ex = tx - d.px, ey = homeY - d.py;
      const dx = Math.abs(ex) < 0.3 ? 0 : Math.max(-1, Math.min(1, ex / 2));
      const dy = Math.abs(ey) < 0.5 ? 0 : Math.max(-1, Math.min(1, ey / 3));
      game.testInput({ dx, dy });
      // a person might tap as soon as the opponent hits (tapEarly) or as the ball comes near
      if (incoming && tappedFor !== d.shots && (opts.tapEarly || d.by > 24)) {
        tappedFor = d.shots;
        const shot = shots[shotIdx++ % shots.length];
        game.testInput({ tap: shot });
        pilot.shotsTapped[shot]++;
      }
    },
  };
  return pilot;
}
