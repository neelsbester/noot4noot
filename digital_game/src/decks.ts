import millennialAnthemsCsv from "../decks/millennial-anthems.csv";
import { GameError } from "./domain/errors";
import type { Deck, Song } from "./domain/types";

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === "\"") {
      if (quoted && line.charAt(index + 1) === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function parseDeck(id: string, name: string, csv: string): Deck {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift();
  if (header !== "title,artist,year,spotify_url") {
    throw new GameError(`Deck ${id} has an invalid header`, "invalid_deck", 500);
  }
  const seen = new Set<string>();
  const songs = lines.map((line, lineIndex): Song => {
    const [title, artist, yearValue, spotifyUrl] = parseCsvLine(line);
    const match = spotifyUrl?.match(/spotify\.com\/track\/([A-Za-z0-9]+)/);
    const year = Number(yearValue);
    if (!title || !artist || !spotifyUrl || !match?.[1] || !Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new GameError(`Deck ${id} has invalid data on line ${lineIndex + 2}`, "invalid_deck", 500);
    }
    if (seen.has(match[1])) throw new GameError(`Deck ${id} contains a duplicate track`, "invalid_deck", 500);
    seen.add(match[1]);
    return {
      id: match[1],
      title,
      artist,
      year,
      spotifyUrl,
      spotifyUri: `spotify:track:${match[1]}`,
    };
  });
  return { id, name, songs };
}

export const MILLENNIAL_ANTHEMS = parseDeck(
  "millennial-anthems",
  "Millennial Anthems",
  millennialAnthemsCsv,
);

export const DECKS = new Map([[MILLENNIAL_ANTHEMS.id, MILLENNIAL_ANTHEMS]]);
export const SONGS = new Map(MILLENNIAL_ANTHEMS.songs.map((song) => [song.id, song]));
