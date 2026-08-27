# REH media-activity

## Files
- `player-media-activity.html`: new Runtime player.
- `main-media-activity.py`: existing FastAPI backend plus a config validation endpoint.
- `media-activity-*.json`: sample configs.

## Runtime URL
Use the same pattern as the current H5P player:

`player-media-activity.html?data=PATH_TO_CONFIG_JSON`

Example:

`player-media-activity.html?data=./data/f4-listening-01.json`

## Supported media types
- `youtube`: `media.src` = normal YouTube URL, youtu.be URL, Shorts URL, or embed URL.
- `audio`: `media.src` = MP3/OGG/etc.
- `image`: `media.src` = image URL/path.
- `text`: `media.content` = plain text.

## Layout
Desktop/tablet wider than 900px:
- media left (default 44%), sticky
- H5P right (default 56%)

Mobile <= 900px:
- media above
- H5P below
- sticky disabled

Optional layout config:
```json
{
  "layout": {
    "media_width": 44,
    "gap": 24,
    "sticky_top": 16,
    "max_width": 1500
  }
}
```

## Backend
The session/event system does not need to change. Existing `EventRequest.event_type` is already generic enough for media-related events.

A new optional endpoint is included:
`POST /api/media-activity/validate`

Use it to validate config JSON before publishing. The player itself is still static and fetches its JSON through `?data=...`.

## Recommended H5P setup
Keep YouTube/audio/image/text OUTSIDE H5P. Use the Lumi H5P embed only for the question/activity area.
