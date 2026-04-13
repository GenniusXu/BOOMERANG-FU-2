import type { GameSnapshot, PlayerId } from '../../../shared/protocol';

export class Hud {
  constructor(
    private readonly connectionStatus: HTMLElement,
    private readonly roomStatus: HTMLElement,
    private readonly scoreStatus: HTMLElement,
    private readonly roundStatus: HTMLElement,
    private readonly replayButton: HTMLButtonElement
  ) {}

  setConnection(text: string): void {
    this.connectionStatus.textContent = text;
  }

  setSnapshot(snapshot: GameSnapshot | null, localPlayerId: PlayerId | null): void {
    if (!snapshot) {
      this.roomStatus.textContent = '房间 0/2';
      this.scoreStatus.textContent = 'P1 0 : 0 P2';
      this.roundStatus.textContent = '等待服务器';
      this.replayButton.hidden = false;
      return;
    }

    const playerLabel = localPlayerId ? `你是 P${localPlayerId}` : '未入房';
    this.roomStatus.textContent = `${playerLabel} | 房间 ${snapshot.players.length}/${snapshot.maxPlayers}`;

    const p1 = snapshot.players.find((player) => player.id === 1);
    const p2 = snapshot.players.find((player) => player.id === 2);
    this.scoreStatus.textContent = `P1 ${p1?.score ?? 0} : ${p2?.score ?? 0} P2`;
    this.roundStatus.textContent = this.describeRound(snapshot);
    this.replayButton.hidden = false;
  }

  onReplayClick(handler: () => void): void {
    this.replayButton.addEventListener('click', handler);
  }

  private describeRound(snapshot: GameSnapshot): string {
    if (snapshot.phase === 'waiting') {
      return '等待第二名玩家';
    }
    if (snapshot.phase === 'playing') {
      return `第 ${snapshot.roundNumber} 小局 | 先到 ${snapshot.scoreToWin} 分`;
    }
    if (snapshot.phase === 'roundEnded') {
      return `P${snapshot.roundWinnerId ?? '?'} 得分，准备下一小局`;
    }
    if (snapshot.phase === 'matchEnded') {
      return `P${snapshot.matchWinnerId ?? '?'} 获胜`;
    }
    return '同步中';
  }
}
