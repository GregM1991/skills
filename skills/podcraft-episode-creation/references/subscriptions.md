# Series subscriptions and AntennaPod

Use this reference when the user wants a separate podcast entry, protected feed
access, or an AntennaPod subscription file.

## Choose the feed

The combined feed is `/api/feed`. A separate series feed is `/api/feed/<slug>`.
The combined feed continues to include all series. Creating a series does not
split an existing podcast-app subscription; the listener adds its series feed
as another subscription.

For listening through the tailnet, use the verified application origin from [api.md](api.md).
For access through the protected gateway, use its configured origin and approved
series path. Inspect live configuration without printing its capability token.
This homelab currently allows the combined feed and the `ddia`, `toylight`, and
`cloudward-ho` series feeds. Confirm another series is allowed before claiming
that its protected subscription is ready.

Keep capability URLs in private export files and private verification evidence.
Share a tailnet download link in chat. The gateway's credentials grant feed and
media access; management and upload requests use the private application origin.

**Complete when:** the selected series feed is reachable through the listener's
chosen access path and contains the expected episode GUIDs and enclosure metadata.

## Deliver an OPML file

An OPML file adds multiple series as separate podcast subscriptions. Use an XML
writer to create one `outline` per series with `type="rss"`, `text`, `title`, and
the verified feed URL in `xmlUrl`. Store the file privately outside build output
and public assets. Confirm that its outlines name exactly the requested feeds.

This homelab already has a two-series export for Toylight and Cloudward, Ho!:

`https://pod.tail.gregmartin.dev/private-exports/dimension20.opml?download=1`

The backing file is `data/subscriptions/dimension20.opml` in the Podcraft checkout.
The download requires tailnet access; the protected feed URLs inside it use the
gateway's access policy. For other collections, inspect available exports or
prepare the requested file and its delivery path before giving a download link.

Verify the response through its Tailscale URL. Require HTTP 200,
`Content-Disposition: attachment; filename="dimension20.opml"` for this export,
`Content-Type: application/octet-stream`, and `Cache-Control: private, no-store`.
Parse the downloaded bytes and compare them with the private file. A normal
browser click must download a file; an XML text page leaves delivery incomplete.

**Complete when:** the verified download contains the requested outlines, works
with a normal click, and its backing file is outside disposable build output.

## Add the subscriptions in AntennaPod

Tell the listener to tap the verified download link, then use AntennaPod's OPML
import from **More → + Add Podcast** and select the saved file and requested
campaigns. See the [AntennaPod subscription guide](https://antennapod.org/documentation/getting-started/subscribe).

For a single series, AntennaPod also accepts its RSS address. A podcast app can
show the same episode under both the combined subscription and a separate series
subscription. Explain that result when both are retained.

Keep client actions as human checks until the listener confirms the separate
podcast entries and playback. Browser and HTTP success establish delivery;
they do not establish that AntennaPod imported the file.

**Complete when:** delivery is verified and the listener's remaining import or
playback action is stated, or the listener has confirmed that action succeeded.
