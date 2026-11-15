# DeepSeek steady

Smaller batches and plainer parameter words for DeepSeek models: each batch of edits stays small,
and when a call fails twice the same way the model stops and says why.

![Before and after](shots/compare.svg)

## What it changes

- **Reasoning** `medium`, `high` for deepseek-reasoner; up to 16000 tokens an answer.
- The words of `aq_edit`: keep batches small.

![A picture from elsewhere](https://i.imgur.com/steady.png)

<script>alert("README")</script>

[Run this](javascript:alert(1)) · [The rules in full](docs/rules.md) · [https://example.com/steady](https://evil.example/)
