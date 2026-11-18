# WalkieTales collection planner

A web page for browsing a big collection of kids' audio (audiobooks, music, podcasts, TV and film audio) and
planning which items go on each child's player. Every item gets a cover, author, narrator, series, length and a short
description, looked up automatically. Each child gets a storage bar, so you can see what fits before copying anything.

It's a companion to [WalkieTales](https://github.com/jaso1000/walkie-tales), but runs on its own and doesn't change
any players. It's a planning tool: the plan exports as a spreadsheet or JSON for loading the players later.

- **Browse:** covers or a list, filters for type, age, time of year, "not planned yet" and "unsure matches".
- **Search that understands kids' content:** "spiderman" also finds Spidey, "marvel" finds the Avengers, "xmas" finds
  Christmas, accents and one typo don't matter.
- **Plan per child:** tap a child on an item, or select many and add them at once. Each child shows how much space their
  plan takes against their phone's free space.
- **Knows what's on each player:** reads every WalkieTales player and shows what's already there, what to add and
  what could go, with real free space.
- **Saves as you go** on the server, so you can carry on from any phone or computer.
- **Exports with every detail** (name and folder on the drive, title, authors, series, length, size, cover, source and
  how sure the match is).

## Run it

```bash
mkdir walkie-tales-planner && cd walkie-tales-planner
curl -O https://raw.githubusercontent.com/jaso1000/walkie-tales-planner/main/docker-compose.yml
mkdir data && docker compose up -d
```

Open `http://<your server>:8475`. The image is `ghcr.io/jaso1000/walkie-tales-planner` (amd64 and arm64). The page
needs a catalogue in `data/`, built from your own list as below. Keep it on your home network: there's no login.

## Link the players

In the ⋯ menu, give each child's WalkieTales player its address and PIN (both are in the player's *Grown-up settings →
Remote control*). The planner reads the players only when you need it: when you open the page (if the last reading is over
10 minutes old) and when you tap *Check the player*. It never contacts them in the background. It matches each
player's folders to your collection. Each child's view shows:

- **On the player** with real sizes, **To add** (planned, not there yet) and **To remove** (there, not planned)
- **Not in collection:** folders on the player that aren't in your list (Sleep Sounds and Messages are the player's own)
- **Add what's on it to the plan**, to start a child's plan from what they already have
- a storage bar using the player's real free space

PINs are kept in `data/players.json` on the server and are never sent to the page. When you copy the plan onto a
player under tidier folder names, list them in `data/folder-links.json` as `{"folder name on the player": "item id"}`
and those folders always match their item exactly. A child's view keeps it simple:
what's planned and whether it fits. *ⓘ The player* shows how the player compares. Sleep Sounds and Messages are the
players' own: they're never counted as something to remove, and the JSON export lists them in `keepOnPlayers`.

## Sync to player

*⇅ Sync to player* in a child's view makes their player match the plan. It shows what it will do first, then:

- removes what's on the player but no longer planned (Sleep Sounds and Messages always stay)
- copies what's planned but missing, from the drive, with tidy folder and track names (download junk, codes and
  run-together words gone; a pack of books as "Book - Chapter 1"; same-name parts as "Part 1, Part 2"), the
  planner's cover and the right type, and the songs of an album in the album's order
- adds planned radio stations and turns on the planned favourites

It skips anything that doesn't fit, carries on if you close the page, and can be stopped after the file it's on.
Copying needs the drive where the planner runs: set `DRIVE_DIR` to the folder the exports' `pathOnDrive` starts
from (the drive itself). With Docker, plug the drive into the server, mount it read-only and set `DRIVE_DIR` (see
`docker-compose.yml`). Without it, the sync still removes, adds stations and sets favourites, and lists what it
couldn't copy. The naming rules are in `names.js`; the WalkieTales remote's *Tidy names* uses the same ones.

## Radio stations

Add live radio stations in the ⋯ menu with a name and a stream address. They're kept in `data/radio.json`, show in the
collection as their own type, take no space, and match the stations already on the players.

## Build your catalogue

You need Python 3 with `pip install rapidfuzz pillow`.

1. **List your collection** in `data/collection.csv` with three columns: `Category` (Audiobooks, Music, Podcasts,
   TV Episodes, Movies, Tonies, Christmas, Easter, Halloween), `Name` (the folder or file name) and `From` (the folder
   it's in, relative to the drive). `sample-data/` has an example, plus a `kids.json` to start from. For something
   that's only on the players so far, put `On the players (not on the drive yet)` as `From`: it's matched like
   everything else, and the exports leave its `pathOnDrive` empty. A fourth column, `Inside` (optional), is for a
   title that sits inside a bigger folder, such as one album in a folder of requests: give the folder path from the
   category folder (`My Requests` or `Disney\Audible`) and the exports' `pathOnDrive` points to the title itself.
2. **Look everything up:** `python tools/enrich.py`. It searches Audible, Open Library, Deezer, Apple, TVmaze and
   Wikipedia, keeps the best match, and saves a 400 px cover for each item. Results are cached in `data/cache/`, so you
   can stop and restart it. `python tools/enrich.py --retry` takes another look at items it wasn't sure about.
3. **Measure the real sizes** (optional) with the drive plugged in: `python tools/scan_drive.py E:\` (or the folder
   that holds `<Category>\<Name>`). It records the size, number of audio files and play time of each item (play time
   needs `pip install mutagen`), uses cover art found on the drive for items without a good match, and remembers where
   each item sits so the exports can give its `pathOnDrive`.
4. **Check the categories** (optional): `python tools/check_categories.py` lists items that look filed in the wrong
   place (song-length tracks in Audiobooks, chapters in Music, Christmas stories outside Christmas…). Put the ones you
   agree with in `data/category-fixes.json` as `{"<id>": {"category": "Music", "why": "songs"}}` and rebuild with
   `python tools/enrich.py --catalog`. Item ids don't change, so plans keep working, and the exports still give the
   folder each item is really in on the drive.
5. Copy `data/` to the server's `data/` folder (the container reads it from `/data`).

Other tools: `tools/covers.py` finds covers for identified items that have none, `tools/embedded_covers.py` takes
the artwork built into the audio files on the drive for items still without one (after a drive scan), and
`tools/redo.py <file of ids>` looks particular items up again.

## Your data

Everything you add stays in `data/`, which isn't part of this repository: your list, the catalogue, covers, the
children and the plan (`data/plan.json`, with a dated copy each day in `data/backups/`). The lookup sends only the
item names to the services above.

## Exports

From the ⋯ menu, or directly:

- `/api/plan.csv`: one row per child and item, with every detail.
- `/api/plan.json`: the children, what's planned for each, and the full details of every planned item.
