---
name: yt-notes
description: Take outline notes on a YouTube video and return them in chat. Use when the user invokes yt-notes or asks for structured notes from a YouTube link or transcript.
---

# YouTube notes

1. Use the video URL or transcript from the user's message or the current thread. If neither is available, ask for the video URL.
2. Read and apply the `youtube-content` skill to get and validate the transcript. If the user supplied the transcript, use it directly. If retrieval fails, report the failure and ask for a transcript. Base the notes on the available source text.
3. Read and apply the `outline-notes` skill to organize the transcript into topic headings, supporting points, and indented details. Use its default depth and source order unless the user requests otherwise. Include the video title and source link when available, and timestamps when the transcript provides them.
4. Return the complete notes as rendered Markdown in the thread. This output rule overrides the dependency skills' default summary, code block, and save suggestions. Do not write the notes to a file or save them to a notes app unless the user asks.

Find dependency skills in the session's skill list or the user's global skill store. If either skill is missing, report the missing dependency before continuing.
