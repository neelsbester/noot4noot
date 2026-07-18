export class GameError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "game_error", status = 400) {
    super(message);
    this.name = "GameError";
    this.code = code;
    this.status = status;
  }
}
