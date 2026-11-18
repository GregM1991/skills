# Plan format for create-tickets

Write one JSON file for each set of tickets:

```json
{
  "parent": 123,
  "labels": ["wayfinder:grilling"],
  "tickets": [
    {
      "key": "store",
      "title": "Decide the session store",
      "body": "## Question\n\nWhich store keeps sessions?"
    },
    {
      "key": "cache",
      "title": "Decide the cache policy",
      "body": "## Question\n\nWhich cache policy follows from {{store:link}}?",
      "labels": ["wayfinder:research"],
      "blockedBy": ["store"]
    }
  ],
  "parentComment": "Shared owners: {{store:link}} owns the session schema."
}
```

| Field | Rule |
| --- | --- |
| `repo` | Optional. `owner/repo`. `--repo` and the current clone are the other sources. |
| `parent` | Optional. The map, or the source issue. Each ticket becomes its sub-issue. The parent must be open. The script does not change the parent body. |
| `labels` | Optional. Labels for every ticket. |
| `tickets[].key` | Required. Letters, digits, `_` and `-`. Unique in the plan. |
| `tickets[].title`, `tickets[].body` | Required. Write the full body. |
| `tickets[].labels` | Optional. Labels for this ticket only. |
| `tickets[].blockedBy` | Optional. Keys of the tickets that block this ticket. A cycle is refused. |
| `parentComment` | Optional. Needs `parent`. Posted one time. |

## References

In a body and in `parentComment`, `{{key}}` becomes `#<number>`, and `{{key:link}}` becomes `[<title>](<url>)`. Use `{{key:link}}` in text that a person reads, so the ticket shows by its name. A reference to a key that is not in the plan is refused.

## Refusals

The script refuses before it writes when a label does not exist in the repository, the parent is closed, or the state file belongs to a different repository or parent. Create a missing label with `gh label create`.
