import type { GameAction, RoomSettings } from "./domain/types";
import { GameError } from "./domain/errors";

export type JsonRecord = Record<string, unknown>;

export function requireRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GameError("Request body must be a JSON object", "invalid_request");
  }
  return value as JsonRecord;
}

export function requireString(
  record: JsonRecord,
  key: string,
  minimum = 1,
  maximum = 200,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new GameError(`${key} is invalid`, "invalid_request");
  }
  return value;
}

export function requireInteger(
  record: JsonRecord,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GameError(`${key} is invalid`, "invalid_request");
  }
  return value as number;
}

export function optionalBoolean(record: JsonRecord, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GameError(`${key} is invalid`, "invalid_request");
  return value;
}

export function parseSettings(value: unknown): Partial<RoomSettings> {
  const record = requireRecord(value ?? {});
  const settings: Partial<RoomSettings> = {};
  if (record.deckId !== undefined) settings.deckId = requireString(record, "deckId", 2, 80);
  if (record.targetCards !== undefined) settings.targetCards = requireInteger(record, "targetCards", 2, 20);
  if (record.startingTokens !== undefined) settings.startingTokens = requireInteger(record, "startingTokens", 0, 5);
  if (record.challengeTimerSeconds !== undefined) {
    const value = requireInteger(record, "challengeTimerSeconds", 0, 60);
    if (![0, 30, 45, 60].includes(value)) throw new GameError("challengeTimerSeconds is invalid", "invalid_request");
    settings.challengeTimerSeconds = value as 0 | 30 | 45 | 60;
  }
  if (record.titleArtistBonus !== undefined) {
    settings.titleArtistBonus = optionalBoolean(record, "titleArtistBonus", true);
  }
  return settings;
}

export function parseGameAction(value: unknown): GameAction {
  const record = requireRecord(value);
  const type = requireString(record, "type", 2, 80);
  switch (type) {
    case "set_ready":
      return {
        type,
        teamId: requireString(record, "teamId", 2, 80),
        ready: optionalBoolean(record, "ready", true),
      };
    case "buy_random_card":
    case "replace_song":
    case "lock_placement":
    case "contest":
    case "pass_challenge":
    case "lock_challenge":
    case "remove_team":
      return { type, teamId: requireString(record, "teamId", 2, 80) };
    case "place":
    case "place_challenge":
      return {
        type,
        teamId: requireString(record, "teamId", 2, 80),
        slot: requireInteger(record, "slot", 0, 100),
      };
    case "start_game":
    case "mark_playback_started":
    case "force_reveal":
    case "award_title_artist_bonus":
    case "next_round":
    case "rematch":
      return { type };
    default:
      throw new GameError("Unknown game action", "unknown_action");
  }
}
