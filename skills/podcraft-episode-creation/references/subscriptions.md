# Series subscriptions and AntennaPod

Use this reference when the user wants a separate podcast entry, protected feed
access, or an AntennaPod subscription file.

## Choose the feed

The combined feed is `/api/feed`. A separate series feed is `/api/feed/<slug>`.
The combined feed continues to include all series. A new series does not
split an existing podcast-app subscription; the listener adds its series feed
as another subscription.

For listening through the tailnet, use the verified application origin from
[api.md](api.md). For access through the protected gateway, use its configured
origin and approved series path. This homelab currently permits the combined
feed and the `ddia`, `toylight`, and `cloudward-ho` series feeds. Make sure that
the gateway permits another series before you report its protected subscription
as ready.

Gateway feed URLs contain a capability token in the path. Keep them in private
export files and private evidence. Do not print them. The `opml-check` command
shows them with the token replaced by `<redacted>`. Share a tailnet download
link in chat. Management and upload requests use the private application
origin; the gateway serves feeds and media only.

`verify` checks the series feed on the private application origin. To check a
gateway feed, run `opml-check --file <private OPML> --check-feeds --expect-episode
<id>` (below) on an OPML file that lists that feed.

**Complete when:** the series feed is reachable through the listener's access
path and contains the expected episode GUIDs and enclosure metadata.

## Deliver an OPML file

An OPML file adds more than one series as separate podcast subscriptions. Use an
XML writer to make one `outline` for each series, with `type="rss"`, `text`,
`title`, and the feed URL in `xmlUrl`. Keep the file private, outside build
output and public assets.

This homelab already has a two-series export for Toylight and Cloudward, Ho!:

`https://pod.tail.gregmartin.dev/private-exports/dimension20.opml?download=1`

The backing file is `data/subscriptions/dimension20.opml` in the Podcraft
checkout. The download needs tailnet access. For other collections, find an
available export, or prepare the file and its delivery path before you give a
download link.

Check the download, the file, the feeds, and the requested episodes:

```bash
python3 "$SKILL_DIR/scripts/podcraft_api.py" opml-check \
  --url "https://pod.tail.gregmartin.dev/private-exports/dimension20.opml?download=1" \
  --file /opt/stacks/podcast-creator/data/subscriptions/dimension20.opml \
  --expect-slug toylight --expect-slug cloudward-ho \
  --check-feeds --expect-episode "$EPISODE_ID"
```

Exit code 0 means that all gates passed. Read `failedGates`:

| Gate | Check |
| --- | --- |
| `downloadStatus`, `attachment`, `contentType`, `cacheControl` | HTTP 200, `attachment; filename="<name>"`, `application/octet-stream`, `private, no-store`. A normal click then downloads a file, not an XML page. |
| `matchesFile` | The downloaded bytes equal the backing file. |
| `outlinesComplete`, `expectedFeeds` | Each outline is complete, and the slugs are exactly the `--expect-slug` values. |
| `feedsReachable` | Each outline feed returns valid RSS through its own access path. |
| `episodesDelivered` | Each `--expect-episode` GUID is in its series feed with the correct number, length, and MIME type, and its enclosure returns the first byte. |

**Complete when:** all gates pass, the listener can download the file with a
normal click, and its backing file is outside disposable build output.

## Add the subscriptions in AntennaPod

Tell the listener to tap the verified download link. Then use AntennaPod's OPML
import from **More → + Add Podcast**, and select the saved file and the
requested series. See the
[AntennaPod subscription guide](https://antennapod.org/documentation/getting-started/subscribe).

For a single series, AntennaPod also accepts its RSS address. A podcast app can
show the same episode in the combined subscription and in a separate series
subscription. Tell the listener about this result when both stay.

Browser and HTTP success prove delivery. They do not prove that AntennaPod
imported the file. Keep the client actions as human checks until the listener
confirms the separate podcast entries and playback.

**Complete when:** delivery is verified and the listener's remaining import or
playback action is stated, or the listener confirms that the action succeeded.
