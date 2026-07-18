"""Build the 200-card Millennial Anthems deck from the audited curated set."""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output" / "curated_top240_hits_pop_2020s.csv"
CATALOG = ROOT / "white_people_turnt.csv"
OUTPUT = ROOT / "output" / "millennial_anthems_200.csv"
REPORT = ROOT / "output" / "millennial_anthems_200_report.txt"

# Songs inherited from the 1980s through radio, films, parties, and family music.
EIGHTIES_SELECTION = {
    ("Whip It", "DEVO"),
    ("Bad Reputation", "Joan Jett & the Blackhearts"),
    ("I Love Rock 'N Roll", "Joan Jett & the Blackhearts"),
    ("Tainted Love", "Soft Cell"),
    ("Africa", "TOTO"),
    ("Hello", "Lionel Richie"),
    ("Material Girl", "Madonna"),
    ("I Wanna Rock", "Twisted Sister"),
    ("Take on Me", "a-ha"),
    ("Oh Yeah", "Yello"),
    ("Venus", "Bananarama"),
    ("Livin' On A Prayer", "Bon Jovi"),
    ("Master Of Puppets", "Metallica"),
    ("Kiss", "Prince"),
    ("Everywhere", "Fleetwood Mac"),
    ("Little Lies", "Fleetwood Mac"),
    ("Love Shack", "The B-52's"),
    ("Like a Virgin", "Madonna"),
    ("Man in the Mirror", "Michael Jackson"),
    ("Beat It", "Michael Jackson"),
}

# Recent songs with strong crossover recognition among adult millennial listeners.
TWENTIES_SELECTION = {
    ("Kings & Queens", "Ava Max"),
    ("Break My Heart", "Dua Lipa"),
    ("Physical", "Dua Lipa"),
    ("You should be sad", "Halsey"),
    ("Midnight Sky", "Miley Cyrus"),
    ("After Hours", "The Weeknd"),
    ("Easy On Me", "Adele"),
    ("Oh My God", "Adele"),
    ("My Head & My Heart", "Ava Max"),
    ("Need to Know", "Doja Cat"),
    ("Woman", "Doja Cat"),
    ("Bad Habits", "Ed Sheeran"),
    ("Shivers", "Ed Sheeran"),
    ("deja vu", "Olivia Rodrigo"),
    ("The Motto", "Tiësto, Ava Max"),
    ("Late Night Talking", "Harry Styles"),
    ("About Damn Time", "Lizzo"),
    ("I Ain't Worried", "OneRepublic"),
    ("Anti-Hero", "Taylor Swift"),
    ("Flowers", "Miley Cyrus"),
    ("BIRDS OF A FEATHER", "Billie Eilish"),
}

# Lower-recognition choices removed in favour of stronger cohort-defining songs.
BASE_EXCLUSIONS = {
    # 1980s
    ("Whip It", "DEVO"),
    ("Bad Reputation", "Joan Jett & the Blackhearts"),
    ("Hello", "Lionel Richie"),
    ("Oh Yeah", "Yello"),
    ("Little Lies", "Fleetwood Mac"),
    # 1990s
    ("I Wanna Rock", "Luke"),
    ("This Is Your Night", "Amber"),
    ("Stop the Rock", "Apollo 440"),
    ("Easily", "Red Hot Chili Peppers"),
    ("No Surprises", "Radiohead"),
    # 2000s
    ("Robot Rock", "Daft Punk"),
    ("Incomplete", "Backstreet Boys"),
    ("Rehab", "Rihanna"),
    ("Makes Me Wonder", "Maroon 5"),
    ("Stop And Stare", "OneRepublic"),
    ("Chasing Pavements", "Adele"),
    ("Big And Chunky", "will.i.am"),
    ("I Like To Move It", "will.i.am"),
    ("Love Me", "Justin Bieber"),
    ("Already Gone", "Kelly Clarkson"),
    ("Good Life", "OneRepublic"),
    ("The Climb", "Miley Cyrus"),
    ("Take Your Shirt Off", "T-Pain"),
    ("Candyman", "Christina Aguilera"),
    ("Bad Influence", "P!nk"),
    # 2010s
    ("Hey", "Lil Jon, 3OH!3"),
    ("Fly", "Nicki Minaj, Rihanna"),
    ("It Girl", "Jason Derulo"),
    ("I Cry", "Flo Rida"),
    ("Whistle", "Flo Rida"),
    ("Radioactive", "Rita Ora"),
    ("Elephant", "Tame Impala"),
    ("The Days", "Avicii"),
    ("Sober", "Childish Gambino"),
    ("Fragile", "Kygo, Labrinth"),
    ("Boys", "Charli xcx"),
    ("Dancing", "Kylie Minogue"),
    ("Streets", "Doja Cat"),
    ("Golden", "Harry Styles"),
    ("G.O.M.D.", "J. Cole"),
    # 2020s
    ("Kings & Queens", "Ava Max"),
    ("You should be sad", "Halsey"),
    ("After Hours", "The Weeknd"),
    ("Oh My God", "Adele"),
    ("BIRDS OF A FEATHER", "Billie Eilish"),
    # Terra cohort-fit refinement: same-decade replacements
    ("Sad But True", "Metallica"),
    ("Creep", "TLC"),
    ("Larger Than Life", "Backstreet Boys"),
    ("Party Up", "DMX"),
    ("505", "Arctic Monkeys"),
    ("The Anthem", "Pitbull, Lil Jon"),
    ("A Milli", "Lil Wayne"),
    ("Smack That", "Akon, Eminem"),
    ("P.I.M.P.", "50 Cent"),
    ("Sweet Dreams", "Beyoncé"),
    ("Rock That Body", "Black Eyed Peas"),
    ("Rock DJ", "Robbie Williams"),
    ("Say It Right", "Nelly Furtado"),
    ("Give Me Love", "Ed Sheeran"),
    ("Trumpets", "Jason Derulo"),
    ("New Americana", "Halsey"),
    ("Blow", "Kesha"),
    ("My Head & My Heart", "Ava Max"),
    ("deja vu", "Olivia Rodrigo"),
    ("Late Night Talking", "Harry Styles"),
    ("The Motto", "Tiësto, Ava Max"),
}

# (catalog title, catalog artist, display title, original release year)
CATALOG_ADDITIONS = [
    # 1990s childhood and school-party staples
    ("Ice Ice Baby", "Vanilla Ice", "Ice Ice Baby", 1989),
    ("Cotton Eye Joe", "Rednex", "Cotton Eye Joe", 1994),
    ("Wonderwall (Remastered)", "Oasis", "Wonderwall", 1995),
    ("All Star", "Smash Mouth", "All Star", 1999),
    ("Barbie Girl", "Aqua", "Barbie Girl", 1997),
    ("Jump Around", "House Of Pain", "Jump Around", 1992),
    ("U Can't Touch This", "MC Hammer", "U Can't Touch This", 1990),
    ("Tubthumping", "Chumbawamba", "Tubthumping", 1997),
    ("Fly Away", "Lenny Kravitz", "Fly Away", 1998),
    ("I Want It That Way", "Backstreet Boys", "I Want It That Way", 1999),
    # 2000s core millennial anthems
    ("A Thousand Miles", "Vanessa Carlton", "A Thousand Miles", 2002),
    ("Teenage Dirtbag", "Wheatus", "Teenage Dirtbag", 2000),
    ("Mr. Brightside", "The Killers", "Mr. Brightside", 2003),
    ("Hey, Soul Sister", "Train", "Hey, Soul Sister", 2009),
    ("In the End", "Linkin Park", "In the End", 2000),
    ("Stacy's Mom", "Fountains Of Wayne", "Stacy's Mom", 2003),
    ("Bring Me To Life", "Evanescence", "Bring Me To Life", 2003),
    ("Teenagers", "My Chemical Romance", "Teenagers", 2006),
    ("Viva La Vida", "Coldplay", "Viva La Vida", 2008),
    ("Use Somebody", "Kings of Leon", "Use Somebody", 2008),
    ("Seven Nation Army", "The White Stripes", "Seven Nation Army", 2003),
    ("Bye Bye Bye", "*NSYNC", "Bye Bye Bye", 2000),
    ("I'm Yours", "Jason Mraz", "I'm Yours", 2008),
    ("Feel Good Inc.", "Gorillaz, De La Soul", "Feel Good Inc.", 2005),
    ("Hips Don't Lie (feat. Wyclef Jean)", "Shakira, Wyclef Jean", "Hips Don't Lie", 2006),
    ("TiK ToK", "Kesha", "TiK ToK", 2009),
    ("Lose Yourself", "Eminem", "Lose Yourself", 2002),
    ("It Wasn't Me", "Shaggy, Rik Rok", "It Wasn't Me", 2000),
    ("Fergalicious", "Fergie, will.i.am", "Fergalicious", 2006),
    ("Hey Ya!", "Outkast", "Hey Ya!", 2003),
    ("Low (feat. T-Pain)", "Flo Rida, T-Pain", "Low", 2007),
    ("Single Ladies (Put a Ring on It)", "Beyoncé", "Single Ladies", 2008),
    ("Umbrella", "Rihanna, JAY-Z", "Umbrella", 2007),
    ("American Idiot", "Green Day", "American Idiot", 2004),
    ("Since U Been Gone", "Kelly Clarkson", "Since U Been Gone", 2004),
    # 2010s young-adult and festival/party staples
    ("We Found Love", "Rihanna, Calvin Harris", "We Found Love", 2011),
    ("Pumped Up Kicks", "Foster The People", "Pumped Up Kicks", 2010),
    ("Some Nights", "fun.", "Some Nights", 2012),
    ("Uptown Funk (feat. Bruno Mars)", "Mark Ronson, Bruno Mars", "Uptown Funk", 2014),
    ("Titanium (feat. Sia)", "David Guetta, Sia", "Titanium", 2011),
    ("Super Bass", "Nicki Minaj", "Super Bass", 2010),
    ("Rolling in the Deep", "Adele", "Rolling in the Deep", 2010),
    ("Closer", "The Chainsmokers, Halsey", "Closer", 2016),
    ("Riptide", "Vance Joy", "Riptide", 2013),
    ("Call Me Maybe", "Carly Rae Jepsen", "Call Me Maybe", 2011),
    # Terra cohort-fit refinement
    ("Wannabe", "Spice Girls", "Wannabe", 1996),
    ("No Scrubs", "TLC", "No Scrubs", 1999),
    ("Say My Name", "Destiny's Child", "Say My Name", 1999),
    ("All The Small Things", "blink-182", "All The Small Things", 1999),
    ("Complicated", "Avril Lavigne", "Complicated", 2002),
    ("The Middle", "Jimmy Eat World", "The Middle", 2001),
    ("Numb", "Linkin Park", "Numb", 2003),
    ("Yeah! (feat. Lil Jon & Ludacris)", "USHER, Lil Jon, Ludacris", "Yeah!", 2004),
    ("Crazy In Love (feat. JAY-Z)", "Beyoncé, JAY-Z", "Crazy In Love", 2003),
    ("Poker Face", "Lady Gaga", "Poker Face", 2008),
    ("I Gotta Feeling", "Black Eyed Peas", "I Gotta Feeling", 2009),
    ("Oops!...I Did It Again", "Britney Spears", "Oops!...I Did It Again", 2000),
    ("Promiscuous", "Nelly Furtado, Timbaland", "Promiscuous", 2006),
    ("Levels - Radio Edit", "Avicii", "Levels", 2011),
    ("Royals", "Lorde", "Royals", 2013),
    ("Shake It Off", "Taylor Swift", "Shake It Off", 2014),
    ("Firework", "Katy Perry", "Firework", 2010),
    ("Levitating (feat. DaBaby)", "Dua Lipa, DaBaby", "Levitating", 2020),
    ("good 4 u", "Olivia Rodrigo", "good 4 u", 2021),
    ("As It Was", "Harry Styles", "As It Was", 2022),
    ("Heat Waves", "Glass Animals", "Heat Waves", 2020),
]


def song_key(row: dict[str, str]) -> tuple[str, str]:
    return row["title"], row["artist"]


def load_source() -> list[dict[str, str]]:
    with SOURCE.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 240:
        raise ValueError(f"Expected 240 audited source rows, found {len(rows)}")
    return rows


def load_catalog_additions() -> list[dict[str, str]]:
    with CATALOG.open(newline="", encoding="utf-8-sig") as handle:
        catalog = {(row["title"], row["artist"]): row for row in csv.DictReader(handle)}

    additions = []
    for source_title, source_artist, display_title, original_year in CATALOG_ADDITIONS:
        source_key = (source_title, source_artist)
        if source_key not in catalog:
            raise ValueError(f"Catalog addition not found: {source_title} — {source_artist}")
        row = dict(catalog[source_key])
        row["title"] = display_title
        row["year"] = str(original_year)
        additions.append(row)
    return additions


def select_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    selected = []
    for row in rows:
        year = int(row["year"])
        key = song_key(row)
        if 1990 <= year <= 2019:
            selected.append(row)
        elif key in EIGHTIES_SELECTION or key in TWENTIES_SELECTION:
            selected.append(row)

    selected = [row for row in selected if song_key(row) not in BASE_EXCLUSIONS]
    selected.extend(load_catalog_additions())
    selected.sort(key=lambda row: (int(row["year"]), row["title"].casefold(), row["artist"].casefold()))
    return selected


def validate(rows: list[dict[str, str]]) -> Counter[int]:
    if len(rows) != 200:
        raise ValueError(f"Expected 200 selected songs, found {len(rows)}")

    urls = [row["spotify_url"] for row in rows]
    if len(set(urls)) != len(urls):
        raise ValueError("Duplicate Spotify URLs in Millennial Anthems selection")

    keys = [(row["title"].casefold(), row["artist"].casefold()) for row in rows]
    if len(set(keys)) != len(keys):
        raise ValueError("Duplicate title and artist pairs in Millennial Anthems selection")

    decades = Counter((int(row["year"]) // 10) * 10 for row in rows)
    expected_decades = {1980: 16, 1990: 38, 2000: 66, 2010: 64, 2020: 16}
    if dict(sorted(decades.items())) != expected_decades:
        raise ValueError(f"Unexpected decade distribution: {dict(sorted(decades.items()))}")
    return decades


def write_outputs(rows: list[dict[str, str]], decades: Counter[int]) -> None:
    with OUTPUT.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["title", "artist", "year", "spotify_url"])
        writer.writeheader()
        writer.writerows(rows)

    report = [
        "Millennial Anthems 200-card selection report",
        "============================================",
        "Audience: broadly millennial listeners, approximately born 1981-1996.",
        "Approach: childhood nostalgia, teen/young-adult staples, party tracks,",
        "alternative/emo, pop, dance, rock, R&B, and hip-hop crossover hits.",
        "",
        f"Audited base: {SOURCE.relative_to(ROOT)}",
        f"Additional candidates: {CATALOG.relative_to(ROOT)}",
        f"Selected: {len(rows)}",
        "Year policy: first public release of the recognizable linked recording.",
        "",
        "Decade distribution:",
    ]
    report.extend(f"  {decade}s: {decades[decade]}" for decade in sorted(decades))
    report.extend(
        [
            "",
            "Selection model:",
            "  - 16 inherited 1980s anthems",
            "  - 38 childhood-era 1990s staples",
            "  - 66 core 2000s millennial anthems",
            "  - 64 young-adult 2010s pop, rock, dance, R&B, and hip-hop tracks",
            "  - 16 recent crossover songs from the 2020s",
            "  - 66 stronger cohort-defining catalog songs replace 66 niche choices",
            "  - Terra refinement applies 21 additional same-decade swaps",
            "  - Terra year corrections: Ice Ice Baby (1989), Show Me Love (1992)",
            "  - unique Spotify URL and title/artist pair required",
            "  - featured-artist, remix, and remaster suffixes may be omitted from the",
            "    printed title when the base song title remains unambiguous",
        ]
    )
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")


def main() -> None:
    rows = select_rows(load_source())
    decades = validate(rows)
    write_outputs(rows, decades)
    print(f"Wrote {len(rows)} songs to {OUTPUT}")
    print("Decades:", dict(sorted(decades.items())))


if __name__ == "__main__":
    main()
